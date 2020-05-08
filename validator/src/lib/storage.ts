
declare namespace Cache {
    type KeyType = string;
    type ValueType = string | number | any[];
}

export interface Cache {
    status: string
    get: (key: Cache.KeyType) => Promise<Cache.ValueType>
    set: (key: Cache.KeyType, value: Cache.ValueType) => Promise<void>
}

export class FakeCache implements Cache {
    status: string = "processing"
    m = new Map()

    async get(key: string): Promise<string> {
      return Promise.resolve(this.m.get(key))
    }

    async set(key: string, value: string): Promise<void> {
      this.m.set(key, value)
    }
}