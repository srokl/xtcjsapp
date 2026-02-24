import { EventEmitter } from 'events'

export class Client extends EventEmitter {
  constructor() {
    super()
  }
  destroy() {}
  listen() {}
  addNode() {}
  announce() {}
  lookup() {}
  toJSON() { return { nodes: [] } }
}

export default Client;
