
const util = require('util')
const EventEmitter = require('events')

const mqtt = require('mqtt')
const _ = require('busyman')
const debug = require('debug')('mqtt-node')

const init = require('./init')
const CNST = require('./constants')
const request = require('./request')
const reporter = require('./reporter')

const { RSP } = CNST
const { TTYPE } = CNST

// Class Method: EventEmitter.listenerCount(emitter, event)

/** ********************************************************************************************** */
/** * MqttNode Class                                                                            ** */
/** ********************************************************************************************** */
function MqttNode (clientId, so, devAttrs) {
  let _transid = 100
  const privateListeners = {}
  const hiddenProps = { writable: true, enumerable: false, configurable: false }

  devAttrs = devAttrs || {}

  if (!_.isString(clientId)) throw new TypeError('clientId should be a string.')
  else if (!_.isObject(so) || !_.isFunction(Object.getPrototypeOf(so).objectList)) throw new TypeError('so should be an instance of SmartObject class.')
  else if (!_.isPlainObject(devAttrs)) throw new TypeError('devAttrs should be an object.')

  EventEmitter.call(this)

  const lsnCounter = this.listenerCount.bind(this)

  this.clientId = clientId
  this.lifetime = Math.floor(devAttrs.lifetime) || 86400 // seconds
  this.ip = devAttrs.ip || null
  this.mac = null
  this.version = devAttrs.version || '0.0.1'

  Object.defineProperty(this, 'mc', _.assign({
    value: null // mqtt client
  }, hiddenProps))

  Object.defineProperty(this, 'mc', _.assign({
    value: null // mqtt client
  }, hiddenProps))

  this.so = so // default smartobjects, initialize in _init()

  Object.defineProperty(this, '_connected', _.assign({ value: false }, hiddenProps))
  Object.defineProperty(this, '_lfsecs', _.assign({ value: 0 }, hiddenProps)) // lifetime counter

  Object.defineProperty(this, '_sleep', _.assign({ value: false }, hiddenProps))
  Object.defineProperty(this, '_brokerUrl', _.assign({ value: null }, hiddenProps))
  Object.defineProperty(this, '_opts', _.assign({ value: null }, hiddenProps))

  // LWMQN interface to publish to, initialize in _init()
  Object.defineProperty(this, '_pubics', _.assign({ value: {} }, hiddenProps))
  // LWMQN interface to subscribe to, initialize in _init()
  Object.defineProperty(this, '_subics', _.assign({ value: {} }, hiddenProps))
  // timeout objects for request control
  Object.defineProperty(this, '_tobjs', _.assign({ value: {} }, hiddenProps))
  // updating upon lifetime alarm
  Object.defineProperty(this, '_updater', _.assign({ value: null }, hiddenProps))
  // collection of report settings
  Object.defineProperty(this, '_repAttrs', _.assign({ value: {} }, hiddenProps))
  // collection of the enabled report senders
  Object.defineProperty(this, '_reporters', _.assign({ value: {} }, hiddenProps))

  Object.defineProperty(this, '_nextTransId', _.assign({
    value (intf) {
      function nextid () {
        if (++_transid > 255) _transid = 0
      }
      nextid()

      if (_.isString(intf)) {
        while (lsnCounter(`${intf}:rsp:${_transid}`) > 0) nextid()
      }

      return _transid
    }
  }, hiddenProps))

  // for testing purpose, don't use it
  Object.defineProperty(this, '__transId', _.assign({
    value () {
      return _transid
    }
  }, hiddenProps))

  Object.defineProperty(this, '_addPrivateListener', _.assign({
    value (emitter, evt, lsn) {
      privateListeners[evt] = privateListeners[evt] || []
      privateListeners[evt].push({
        emitter,
        listener: lsn
      })
      emitter.on(evt, lsn)
    }
  }, hiddenProps))

  Object.defineProperty(this, '_removePrivateListeners', _.assign({
    value (emitter, evt) {
      let lsnRecs = privateListeners[evt]

      if (lsnRecs && lsnRecs.length !== 0) {
        _.forEach(lsnRecs, (rec) => {
          if (rec.emitter === emitter) emitter.removeListener(evt, rec.listener)
        })

        _.remove(lsnRecs, rec => rec.emitter === emitter)
      }

      if (lsnRecs && lsnRecs.length === 0) {
        lsnRecs = null
        delete privateListeners[evt]
      }
    }
  }, hiddenProps))

  this.identify = function (callback) {
    callback(new Error('Identify is not implemented'))
  }

  this.encrypt = function (msgStr, callback) { // Overide at will
    callback(null, msgStr)
  }

  this.decrypt = function (msgBuf, callback) { // Overide at will
    callback(null, msgBuf)
  }

  init(this)
  debug('qnode created, clientId: %s', clientId)
}

util.inherits(MqttNode, EventEmitter)

/** ********************************************************************************************** */
/** * Protected Methods                                                                         ** */
/** ********************************************************************************************** */
MqttNode.prototype._target = function (oid, iid, rid) {
  const trg = {
    type: null,
    exist: this.getSmartObject().has(oid, iid, rid)
  }

  if (!_.isNil(oid)) {
    trg.type = (oid === '') ? TTYPE.root : TTYPE.obj
    if (!_.isNil(iid)) {
      trg.type = TTYPE.inst
      if (!_.isNil(rid)) trg.type = TTYPE.rsc
    }
  }

  return trg
}

MqttNode.prototype._lifeUpdate = function (enable, callback) {
  const self = this

  callback = callback || function () {}

  this._lfsecs = 0
  clearInterval(this._updater)
  this._updater = null

  if (enable) {
    this._updater = setInterval(() => {
      self._lfsecs += 1
      if (self._lfsecs === self.lifetime) {
        self._update({ lifetime: self.lifetime }, callback)
        self._lfsecs = 0
      }
    }, 1000)
  }
}

/** ********************************************************************************************** */
/** * Public Methods                                                                            ** */
/** ********************************************************************************************** */
MqttNode.prototype.getSmartObject = function () {
  return this.so
}

MqttNode.prototype.isConnected = function () {
  return this._connected
}

MqttNode.prototype.enableReport = function (oid, iid, rid) {
  if (!_.isNil(rid)) {
    if (!_.isString(rid) && !_.isNumber(rid)) throw new TypeError('rid should be a string or a number.')
  }
  return reporter.enableReport(this, oid, iid, rid)
}

MqttNode.prototype.disableReport = function (oid, iid, rid) {
  if (!_.isNil(rid)) {
    if (!_.isString(rid) && !_.isNumber(rid)) throw new TypeError('rid should be a string or a number.')
  }
  return reporter.disableReport(this, oid, iid, rid)
}

/** ********************************************************************************************** */
/** * Public Methods - MQTT Interfaces                                                          ** */
/** ********************************************************************************************** */
MqttNode.prototype._emitError = function (err) {
  if (!this.listenerCount('error')) throw err
  else this.emit('error', err)
}

MqttNode.prototype.connect = function (brokerUrl, opts, callback) {
  const self = this
  const lsnEvtsToRemove = ['connect', 'message', 'reconnect', 'close', 'offline', 'error']

  if (_.isFunction(opts)) {
    callback = opts
    opts = undefined
  }

  opts = opts || {}
  callback = callback || function (err, rsp) {
    if (err) self._emitError(err)
  }

  if (!_.isString(brokerUrl)) throw new TypeError('brokerUrl should be a string.')

  if (!_.isPlainObject(opts)) throw new TypeError('opts should be an object if given.')

  if (!_.has(opts, 'reconnectPeriod')) opts.reconnectPeriod = 3000

  if (_.has(opts, 'clientId') && (opts.clientId !== this.clientId)) throw new Error('clientId cannot be changed.')

  this._brokerUrl = brokerUrl
  this._opts = opts

  opts = _.assign(opts, { clientId: this.clientId })

  if (this.mc && this.isConnected()) {
    this.register(callback)
    return this
  }

  this.once('_connect_cb', (data) => {
    if (data.err) {
      if (_.isFunction(callback)) callback(data.err)
      else self._emitError(data.err)
    } else {
      callback(null, data.rsp)
      setImmediate(() => {
        self.emit('login')
      })
    }
  })

  this.mc = mqtt.connect(brokerUrl, opts)

  lsnEvtsToRemove.forEach((evt) => {
    self._removePrivateListeners(self.mc, evt)
  })

  this._addPrivateListener(this.mc, 'connect', (connack) => {
    debug('Connect to broker')

    self.emit('connect', connack)
    self.emit('_connected')
  })

  this._addPrivateListener(this.mc, 'message', (topic, message, packet) => {
    self.emit('raw', topic, message, packet)
  })

  this._addPrivateListener(this.mc, 'reconnect', () => {
    self.emit('reconnect')
  })

  this._addPrivateListener(this.mc, 'close', () => {
    debug('Disconnect from broker')
    self.emit('logout')
    self.emit('_unconnected')
  })

  this._addPrivateListener(this.mc, 'offline', () => {
    self.emit('offline')
    self.emit('_unconnected')
  })

  this._addPrivateListener(this.mc, 'error', (err) => {
    self._emitError(err)
  })

  return this
}

MqttNode.prototype.close = function (force, callback) {
  const self = this
  const lsnEvtsToRemove = ['connect', 'message', 'reconnect', 'close', 'offline', 'error']

  if (_.isFunction(force)) {
    callback = force
    force = false
  }

  if (!_.isUndefined(force) && !_.isBoolean(force)) throw new TypeError('force should be a boolean if given.')

  force = !!force

  callback = callback || function (err, rsp) {
    if (err) self._emitError(err)
  }

  if (this.mc) {
    this.mc.end(force, () => {
      lsnEvtsToRemove.forEach((evt) => {
        self._removePrivateListeners(self.mc, evt)
      })

      self.mc = null
      if (_.isFunction(callback)) callback()
    })
  } else if (_.isFunction(callback)) {
    process.nextTick(() => {
      callback(new Error('No mqtt client attached on qnode, cannot close connection.'))
    })
  }

  return this
}

MqttNode.prototype.publish = function (topic, message, options, callback) {
  const self = this
  let errText

  if (_.isFunction(options)) {
    callback = options
    options = undefined
  }

  options = options || { qos: 0, retain: false }

  if (!_.isFunction(callback)) throw new TypeError('callback should be given and should be a function.')

  if (_.isPlainObject(message)) message = JSON.stringify(message)

  if (!this.mc) errText = 'No mqtt client established.'
  else if (!this.isConnected()) errText = 'No connection.'
  else if (!_.isString(message) && !Buffer.isBuffer(message)) errText = 'Message should be a string or a buffer.'

  if (errText) {
    process.nextTick(() => {
      callback(new Error(errText), null)
    })
  } else {
    if (!_.isFunction(this.encrypt)) {
      this.encrypt = function (msgStr, callback) {
        callback(null, msgStr)
      }
    }

    this.encrypt(message, (err, encrypted) => {
      if (!err) {
        self.mc.publish(topic, encrypted, options, () => {
          self.emit('published', {
            topic,
            message: encrypted,
            options
          })

          callback(null, encrypted)
        })
      } else {
        callback(err)
      }
    })
  }

  return this
}

MqttNode.prototype.subscribe = function (topics, opts, callback) {
  if (_.isFunction(opts)) {
    callback = opts
    opts = { qos: 0 }
  }

  if (!_.isFunction(callback)) throw new TypeError('callback should be given and should be a function.')

  this.mc.subscribe(topics, opts, callback) // function (err, granted)
  return this
}

MqttNode.prototype.unsubscribe = function (topics, callback) {
  if (!_.isFunction(callback)) throw new TypeError('callback should be given and should be a function.')

  this.mc.unsubscribe(topics, callback)
  return this
}

/** ********************************************************************************************** */
/** * Public Methods - LWM2M Interfaces                                                         ** */
/** ********************************************************************************************** */
MqttNode.prototype.register = function (callback) {
  if (!_.isFunction(callback)) throw new TypeError('callback should be given and should be a function.')

  return request.register(this, callback)
}

MqttNode.prototype.deregister = function (callback) {
  if (!_.isFunction(callback)) throw new TypeError('callback should be given and should be a function.')

  return request.deregister(this, callback)
}

MqttNode.prototype.checkin = function (callback) {
  if (!_.isFunction(callback)) throw new TypeError('callback should be given and should be a function.')

  this._sleep = false

  return request.checkin(this, callback)
}

MqttNode.prototype.checkout = function (duration, callback) {
  if (_.isFunction(duration)) {
    callback = duration
    duration = undefined
  }

  if (!_.isFunction(callback)) throw new TypeError('callback should be given and should be a function.')

  duration = duration || 0
  reporter.clear(this)
  this._sleep = true

  return request.checkout(this, duration, callback)
}

MqttNode.prototype._update = function (devAttrs, callback) {
  // Change of mac address and clientId at runtime will be ignored
  if (!_.isPlainObject(devAttrs)) throw new TypeError('devAttrs should be an object.')

  if (!_.isFunction(callback)) throw new TypeError('callback should be given and should be a function.')

  return request.update(this, devAttrs, callback)
}

MqttNode.prototype.update = function (attrs, callback) {
  const self = this
  const so = this.getSmartObject()
  let localStatus
  const updater = {}

  if (!_.isPlainObject(attrs)) throw new TypeError('attrs should be an object.')
  else if (!_.isFunction(callback)) throw new TypeError('callback should be given and should be a function.')

  _.forEach(attrs, (attr, key) => {
    if (key === 'lifetime') {
      self.lifetime = updater.lifetime = attrs.lifetime
      so.set('lwm2mServer', 0, 'lifetime', attrs.lifetime)
    } else if (key === 'ip') {
      self.ip = updater.ip = attrs.ip
    } else if (key === 'version') {
      self.version = updater.version = attrs.version
    } else if (key === 'mac' || key === 'clientId') {
      localStatus = localStatus || RSP.notallowed
    } else {
      localStatus = localStatus || RSP.badreq
    }
  })

  if (localStatus && _.isFunction(callback)) {
    setImmediate(() => {
      callback(null, { status: localStatus })
    })
  } else {
    self._lifeUpdate(true) // schedule next update at lifetime
    this._update(updater, callback)
  }

  return this
}

// [TODO] Deprecated - take off at next major version bumped
MqttNode.prototype.setDevAttrs = function (attrs, callback) {
  if (!_.isFunction(callback)) throw new TypeError('callback should be given and should be a function.')

  return this.update(attrs, callback)
}

MqttNode.prototype.notify = function (data, callback) {
  if (!_.isPlainObject(data)) throw new TypeError('data should be an object.')

  if (!_.isFunction(callback)) throw new TypeError('callback should be given and should be a function.')

  return request.notify(this, data, callback)
}

MqttNode.prototype.respond = function (rsp, callback) {
  if (_.isUndefined(callback)) callback = function () {}

  return this.publish(this._pubics.response, rsp, callback)
}

MqttNode.prototype.ping = function (callback) {
  if (!_.isFunction(callback)) throw new TypeError('callback should be given and should be a function.')

  return request.ping(this, callback)
}

module.exports = MqttNode
