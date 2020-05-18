require('dotenv').config()
const path = require('path')
const { connectSenderToQueue } = require('./services/amqpClient')
const { redis, redlock } = require('./services/redisClient')
const GasPrice = require('./services/gasPrice')
const logger = require('./services/logger')
const rpcUrlsManager = require('./services/getRpcUrlsManager')
const { sendTx } = require('./tx/sendTx')
const { getNonce, getChainId } = require('./tx/web3')
const privateKey = require('../config/private-keys.config')
const {
  addExtraGas,
  checkHTTPS,
  privateKeyToAddress,
  syncForEach,
  waitForFunds,
  watchdog,
  nonceError,
  blockGasLimitExceededError,
} = require('./utils/utils')
const { EXIT_CODES, EXTRA_GAS_PERCENTAGE } = require('./utils/constants')
const { processEvents } = require('./events')

const { REDIS_LOCK_TTL } = process.env

if (process.argv.length < 3) {
  logger.error('Please check the number of arguments, config file was not provided')
  process.exit(EXIT_CODES.GENERAL_ERROR)
}

const config = require(path.join('../config/', process.argv[2]))

const web3Instance = config.web3
const nonceLock = `lock:${config.id}:nonce`
const nonceKey = `${config.id}:nonce`
let chainId = 0
let VALIDATOR_ADDRESS
async function initialize() {
  try {
    await config.initialize()
    VALIDATOR_ADDRESS = config.validatorAddress

    const checkHttps = checkHTTPS(process.env.ALLOW_HTTP, logger)

    rpcUrlsManager.homeUrls.forEach(checkHttps('home'))
    rpcUrlsManager.foreignUrls.forEach(checkHttps('foreign'))

    GasPrice.start(config.id)

    chainId = await getChainId(config.id)
    connectSenderToQueue({
      queueName: config.queue,
      cb: (options) => {
        if (config.maxProcessingTime) {
          return watchdog(
            () => main(options),
            config.maxProcessingTime,
            () => {
              logger.fatal(`Max processing time ${config.maxProcessingTime} reached`)
              process.exit(EXIT_CODES.MAX_TIME_REACHED)
            },
          )
        }

        return main(options)
      },
    })
  } catch (e) {
    logger.error(e.message)
    process.exit(EXIT_CODES.GENERAL_ERROR)
  }
}

function resume(newBalance) {
  logger.info(`Validator balance changed. New balance is ${newBalance}. Resume messages processing.`)
  initialize()
}

async function readNonce(forceUpdate) {
  logger.debug('Reading nonce')
  if (forceUpdate) {
    logger.debug('Forcing update of nonce')
    return getNonce(web3Instance, VALIDATOR_ADDRESS)
  }

  const nonce = await redis.get(nonceKey)
  if (nonce) {
    logger.debug({ nonce }, 'Nonce found in the DB')
    return Number(nonce)
  }
  logger.debug("Nonce wasn't found in the DB")
  return getNonce(web3Instance, VALIDATOR_ADDRESS)
}

function updateNonce(nonce) {
  return redis.set(nonceKey, nonce)
}

async function main({ msg, ackMsg, nackMsg, sendToQueue, channel }) {
  try {
    if (redis.status !== 'ready') {
      nackMsg(msg)
      return
    }

    const task = JSON.parse(msg.content)
    logger.info(`Task ${task.eventType} received with ${task.events.length} events to process`)
    const jobs = await processEvents(task.eventType, task.events)

    const gasPrice = GasPrice.getPrice()
    const ttl = Number(REDIS_LOCK_TTL) * jobs.length

    logger.debug(`Acquiring lock: ${nonceLock}, TTL: ${ttl}ms`)
    const lock = await redlock.lock(nonceLock, ttl)
    logger.debug('Lock acquired')

    let nonce = await readNonce()
    let insufficientFunds = false
    let minimumBalance = null
    const failedEvents = []

    logger.debug(`Sending ${jobs.length} transactions`)
    await syncForEach(jobs, async (job) => {
      const gasLimit = addExtraGas(job.gasEstimate, EXTRA_GAS_PERCENTAGE)

      try {
        logger.info(`Sending transaction with nonce ${nonce}`)
        const txHash = await sendTx({
          chain: config.id,
          data: job.data,
          nonce,
          gasPrice: gasPrice.toString(10),
          amount: '0',
          gasLimit,
          privateKey: await privateKey.getValidatorKey(),
          to: job.to,
          chainId,
          web3: web3Instance,
        })

        nonce += 1
        logger.info(
          { eventTransactionHash: job.transactionReference, generatedTransactionHash: txHash },
          `Tx generated ${txHash} for event Tx ${job.transactionReference}`,
        )
      } catch (e) {
        logger.error(
          { eventTransactionHash: job.transactionReference, error: e.message },
          `Tx Failed for event Tx ${job.transactionReference}:
           from: ${privateKeyToAddress(await privateKey.getValidatorKey())}
           to: ${job.to}
           gasPrice: ${gasPrice.toString(10)}
           gasLimit: ${gasLimit}
           data: ${job.data}
           chain: ${config.id}
           nonce: ${nonce}
           chainId: ${chainId}
           amount: "0"`,
          e.message,
        )
        if (
          !e.message.includes('Transaction with the same hash was already imported') &&
          !blockGasLimitExceededError(e)
        ) {
          failedEvents.push(job)
        }

        if (e.message.includes('Insufficient funds')) {
          insufficientFunds = true
          const currentBalance = await web3Instance.eth.getBalance(VALIDATOR_ADDRESS)
          minimumBalance = gasLimit.multipliedBy(gasPrice)
          logger.error(
            `Insufficient funds: ${currentBalance}. Stop processing messages until the balance is at least ${minimumBalance}.`,
          )
        } else if (nonceError(e)) {
          nonce = await readNonce(true)
        }
      }
    })

    logger.debug('Updating nonce')
    await updateNonce(nonce)

    logger.debug('Releasing lock')
    await lock.unlock()

    if (failedEvents.length) {
      logger.info(`Sending ${failedEvents.length} failed "${task.eventType}" event to Queue`)
      await sendToQueue({
        eventType: task.eventType,
        events: failedEvents,
      })
    }
    ackMsg(msg)
    logger.debug(`Finished processing msg`)

    if (insufficientFunds) {
      logger.warn('Insufficient funds. Stop sending transactions until the account has the minimum balance')
      channel.close()
      waitForFunds(web3Instance, VALIDATOR_ADDRESS, minimumBalance, resume, logger)
    }
  } catch (e) {
    logger.error(e)
    nackMsg(msg)
  }

  logger.debug('Finished')
}

initialize()
