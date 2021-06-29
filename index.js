#!/usr/bin/env node

/**
 * iOS 端 监听的端口号
 */
const QVKeyboardProtocolIPv4PortNumber = 6921

/**
 * 双方通信中约定的 FrameType
 */

// ios -> macos
const QVKeyboardFrameTypeDeviceInfo = 1000
const QVKeyboardFrameTypePong = 1001
const QVKeyboardFrameTypeStop = 1002

// macos -> ios
const QVKeyboardFrameTypePing = 2000
const QVKeyboardFrameTypeDeleteBackward = 2001

// ios <=> macos
const QVKeyboardFrameTypeTextMessage = 3000

const PTProtocolVersion1 = 1
const PTFrameNoTag = 0
const PT_FRAME_HEAD_SIZE = 0x10
// https://github.com/rsms/peertalk/blob/b88b1f8b08a3e2a15d8a36cf41670d867837b415/peertalk/PTProtocol.m#L10-L26

class PTFrame {
  static encode ({
    version = PTProtocolVersion1,
    type,
    tag = PTFrameNoTag,
    payload
  }) {
    let payloadSize = 0

    if (payload) {
      if (!(payload instanceof Buffer)) {
        throw new Error('invalid payload type, must be a Buffer')
      }

      payloadSize = payload.length
    }

    const buf = Buffer.alloc(PT_FRAME_HEAD_SIZE + payloadSize)

    buf.writeUInt32BE(version, 0)
    buf.writeUInt32BE(type, 4)
    buf.writeUInt32BE(tag, 8)
    buf.writeUInt32BE(payloadSize, 12)

    if (payloadSize) {
      payload.copy(buf, PT_FRAME_HEAD_SIZE)
    }

    // console.log('encode:', { buf })

    return buf
  }

  static decode (data) {
    const version = data.readUInt32BE(0)
    const type = data.readUInt32BE(4)
    const tag = data.readUInt32BE(8)
    const payloadSize = data.readUInt32BE(12)

    const length = data.length
    const payload = data.slice(length - payloadSize)

    // console.log('decode:', {version, type, tag, payloadSize, length, data, payload})

    return {
      version,
      type,
      tag,
      payloadSize,
      payload
    }
  }
}

const wrapTunnel = (tunnel) => {
  const events = require('events')
  const event = new events.EventEmitter()

  event.on('send', (data) => tunnel.write(PTFrame.encode(data)))

  tunnel.on('data', (data) => event.emit('data', PTFrame.decode(data)))
  tunnel.on('error', (e) => event.emit('error', e))
  tunnel.on('close', (e) => event.emit('close'))

  return event
}

const keepalive = (device) => new Promise((resolve, reject) => {
  let tagno = 0

  const ping = () => setTimeout(() => {
    device.emit('send', {
      type: QVKeyboardFrameTypePing,
      tag: ++tagno
    })
  }, 1000)

  device.on('error', (e) => {
    reject(e)
  })

  device.on('data', (data) => {
    const { type/*, payload */ } = data

    switch (type) {
      case QVKeyboardFrameTypeDeviceInfo: // 在与App连接成功后, 会收到这个事件, 代表连接成功, 可发送消息了
        // const bplist = require('bplist-parser')
        // console.log('Connect Success, DeviceInfo:', JSON.stringify(bplist.parseBuffer(payload), 0, 2))
        console.log('🌈 Ready for typing :)')

        ping()

        resolve(device)
        return
      case QVKeyboardFrameTypePong:
        // console.log('Poll', payload)
        ping()
        return
      case QVKeyboardFrameTypeStop:
        device.emit('close')
        console.log('🤔 Keyboard disappear ...:)')
        return
    }

    console.log(data)
  })
})

/**
 * 对要发布的内容进行包装
 */
const QVKeyboardTextFrame = (data) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)

  return Buffer.concat([length, data])
}

/**
 * 捕获 stdin 中接收到的数据 并转发至 ios 端
 */
const keyboard = (device) => {
  process.stdin.setRawMode(true)
  process.stdin.resume()

  device.on('close', () => {
    console.log('🤔 Disconnect form iPhone ...')
    process.exit(0)
  })

  device.on('error', (e) => {
    console.error('device error', e)

    process.exit(2)
  })

  process.stdin.on('data', (buf) => {
    // console.log('Send:', JSON.stringify(buf), buf.toString('hex').toUpperCase().replace(/(..)/g, '$1 '))

    if (buf.length === 1) {
      if (buf[0] === 0x7f) { // 0x7f === 127 === backspace
        device.emit('send', {
          type: QVKeyboardFrameTypeDeleteBackward
        })
        return
      }

      if (buf[0] === 0x0D) { // fix \r to \n
        buf[0] = 0x0A
      }
    }

    device.emit('send', {
      type: QVKeyboardFrameTypeTextMessage,
      payload: QVKeyboardTextFrame(buf)
    })
  })
}

require('usbmux')
  .getTunnel(QVKeyboardProtocolIPv4PortNumber)
  .then(wrapTunnel)
  .then(keepalive)
  .then(keyboard)
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
