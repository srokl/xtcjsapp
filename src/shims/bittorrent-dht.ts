import { EventEmitter } from 'events'

export class Client extends EventEmitter {
  constructor() {
    super()
  }
  destroy() {}
  listen() {}
  addNode() {}
}

export default Client;
