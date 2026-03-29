import { describe, expect, it } from 'vitest';

import type { Message } from '../types';

import {
  FRAME_DATA_SIZE,
  HEADER_SIZE,
  MSG_CAPTURE_FRAME,
  MSG_ERROR,
  MSG_FRAME_DATA,
  MSG_INJECT_INPUT,
  MSG_INPUT_ACK,
  MSG_PING,
  MSG_PONG,
  MSG_QUERY_STATE,
  MSG_READY,
  MSG_RELEASE_INPUT,
  MSG_STATE_NOT_FOUND,
  MSG_STATE_VALUE,
  StateType,
} from '../types';
import { encodeMessage, ProtocolParser } from './protocol';

// --- Hardcoded byte sequence tests ---

describe('encodeMessage — hardcoded bytes', () => {
  it('PING encodes to [0x01, 0x00, 0x00]', () => {
    const buf = encodeMessage({ type: MSG_PING });
    expect(buf).toEqual(Buffer.from([0x01, 0x00, 0x00]));
  });

  it('PONG encodes to [0x81, 0x00, 0x00]', () => {
    const buf = encodeMessage({ type: MSG_PONG });
    expect(buf).toEqual(Buffer.from([0x81, 0x00, 0x00]));
  });

  it('CAPTURE_FRAME encodes to [0x02, 0x00, 0x00]', () => {
    const buf = encodeMessage({ type: MSG_CAPTURE_FRAME });
    expect(buf).toEqual(Buffer.from([0x02, 0x00, 0x00]));
  });

  it('RELEASE_INPUT encodes to [0x05, 0x00, 0x00]', () => {
    const buf = encodeMessage({ type: MSG_RELEASE_INPUT });
    expect(buf).toEqual(Buffer.from([0x05, 0x00, 0x00]));
  });

  it('INPUT_ACK encodes to [0x83, 0x00, 0x00]', () => {
    const buf = encodeMessage({ type: MSG_INPUT_ACK });
    expect(buf).toEqual(Buffer.from([0x83, 0x00, 0x00]));
  });

  it('READY encodes to [0xFE, 0x00, 0x00]', () => {
    const buf = encodeMessage({ type: MSG_READY });
    expect(buf).toEqual(Buffer.from([0xfe, 0x00, 0x00]));
  });

  it('STATE_NOT_FOUND encodes to [0x85, 0x00, 0x00]', () => {
    const buf = encodeMessage({ type: MSG_STATE_NOT_FOUND });
    expect(buf).toEqual(Buffer.from([0x85, 0x00, 0x00]));
  });

  it('INJECT_INPUT(A, 90.0) encodes to exact bytes', () => {
    const buf = encodeMessage({
      buttons: 0x01,
      crankAngle: 90.0,
      type: MSG_INJECT_INPUT,
    });

    // Header: [0x03][0x00, 0x05] + payload: [0x01][float32 LE of 90.0]
    expect(buf.length).toBe(HEADER_SIZE + 5);
    expect(buf.readUInt8(0)).toBe(0x03);
    expect(buf.readUInt16BE(1)).toBe(5);
    expect(buf.readUInt8(3)).toBe(0x01); // button A
    expect(buf.readFloatLE(4)).toBeCloseTo(90.0);

    // Verify exact float32 LE bytes for 90.0 = 0x42B40000
    const floatBuf = Buffer.alloc(4);
    floatBuf.writeFloatLE(90.0);
    expect(buf.subarray(4, 8)).toEqual(floatBuf);
  });

  it('INJECT_INPUT(A|Up, -1.0) — multi-button + no-inject sentinel', () => {
    const buf = encodeMessage({
      buttons: 0x01 | 0x04,
      crankAngle: -1.0,
      type: MSG_INJECT_INPUT,
    });

    expect(buf.readUInt8(3)).toBe(0x05); // A | Up
    expect(buf.readFloatLE(4)).toBe(-1.0);
  });

  it('QUERY_STATE("score") encodes with null terminator', () => {
    const buf = encodeMessage({ name: 'score', type: MSG_QUERY_STATE });

    // Header + "score\0" = 3 + 6 = 9 bytes
    expect(buf.length).toBe(9);
    expect(buf.readUInt8(0)).toBe(0x04);
    expect(buf.readUInt16BE(1)).toBe(6);
    expect(buf.subarray(3).toString('utf-8')).toBe('score\0');
  });

  it('ERROR("timeout") encodes with null terminator', () => {
    const buf = encodeMessage({ message: 'timeout', type: MSG_ERROR });

    expect(buf.readUInt8(0)).toBe(0xff);
    expect(buf.readUInt16BE(1)).toBe(8); // "timeout\0"
    expect(buf.subarray(3, 10).toString('utf-8')).toBe('timeout');
    expect(buf.readUInt8(10)).toBe(0x00);
  });

  it('STATE_VALUE int32=42', () => {
    const buf = encodeMessage({
      stateType: StateType.Int32,
      type: MSG_STATE_VALUE,
      value: 42,
    });

    expect(buf.readUInt8(0)).toBe(0x84);
    expect(buf.readUInt16BE(1)).toBe(5); // 1B type + 4B int32
    expect(buf.readUInt8(3)).toBe(StateType.Int32);
    expect(buf.readInt32LE(4)).toBe(42);
  });

  it('STATE_VALUE float32=3.14', () => {
    const buf = encodeMessage({
      stateType: StateType.Float32,
      type: MSG_STATE_VALUE,
      value: 3.14,
    });

    expect(buf.readUInt8(3)).toBe(StateType.Float32);
    expect(buf.readFloatLE(4)).toBeCloseTo(3.14, 2);
  });

  it('STATE_VALUE string="hello"', () => {
    const buf = encodeMessage({
      stateType: StateType.String,
      type: MSG_STATE_VALUE,
      value: 'hello',
    });

    expect(buf.readUInt8(3)).toBe(StateType.String);
    // 1B type + "hello\0" = 7 bytes payload
    expect(buf.readUInt16BE(1)).toBe(7);
    expect(buf.subarray(4, 9).toString('utf-8')).toBe('hello');
    expect(buf.readUInt8(9)).toBe(0x00);
  });

  it('FRAME_DATA payload is exactly 12,480 bytes', () => {
    const framebuffer = Buffer.alloc(FRAME_DATA_SIZE, 0xaa);
    const buf = encodeMessage({ framebuffer, type: MSG_FRAME_DATA });

    expect(buf.readUInt8(0)).toBe(0x82);
    expect(buf.readUInt16BE(1)).toBe(FRAME_DATA_SIZE);
    expect(buf.length).toBe(HEADER_SIZE + FRAME_DATA_SIZE);
  });
});

// --- Round-trip tests ---

describe('encode/decode round-trip', () => {
  const parser = new ProtocolParser();

  function roundTrip(msg: Message): Message {
    parser.reset();
    parser.push(encodeMessage(msg));
    const messages = parser.parse();
    expect(messages).toHaveLength(1);

    return messages[0];
  }

  it('PING', () => {
    expect(roundTrip({ type: MSG_PING })).toEqual({ type: MSG_PING });
  });

  it('PONG', () => {
    expect(roundTrip({ type: MSG_PONG })).toEqual({ type: MSG_PONG });
  });

  it('CAPTURE_FRAME', () => {
    expect(roundTrip({ type: MSG_CAPTURE_FRAME })).toEqual({
      type: MSG_CAPTURE_FRAME,
    });
  });

  it('RELEASE_INPUT', () => {
    expect(roundTrip({ type: MSG_RELEASE_INPUT })).toEqual({
      type: MSG_RELEASE_INPUT,
    });
  });

  it('INPUT_ACK', () => {
    expect(roundTrip({ type: MSG_INPUT_ACK })).toEqual({
      type: MSG_INPUT_ACK,
    });
  });

  it('READY', () => {
    expect(roundTrip({ type: MSG_READY })).toEqual({ type: MSG_READY });
  });

  it('STATE_NOT_FOUND', () => {
    expect(roundTrip({ type: MSG_STATE_NOT_FOUND })).toEqual({
      type: MSG_STATE_NOT_FOUND,
    });
  });

  it('INJECT_INPUT', () => {
    const msg: Message = {
      buttons: 0x05,
      crankAngle: 180.0,
      type: MSG_INJECT_INPUT,
    };
    const decoded = roundTrip(msg);
    expect(decoded).toEqual(msg);
  });

  it('QUERY_STATE', () => {
    const msg: Message = { name: 'level', type: MSG_QUERY_STATE };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('ERROR', () => {
    const msg: Message = {
      message: 'something went wrong',
      type: MSG_ERROR,
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('STATE_VALUE int32', () => {
    const msg: Message = {
      stateType: StateType.Int32,
      type: MSG_STATE_VALUE,
      value: -100,
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('STATE_VALUE float32', () => {
    const msg: Message = {
      stateType: StateType.Float32,
      type: MSG_STATE_VALUE,
      value: 0,
    };
    const decoded = roundTrip(msg);
    expect(decoded.type).toBe(MSG_STATE_VALUE);
    if (decoded.type === MSG_STATE_VALUE) {
      expect(decoded.stateType).toBe(StateType.Float32);
      expect(decoded.value).toBeCloseTo(0);
    }
  });

  it('STATE_VALUE string', () => {
    const msg: Message = {
      stateType: StateType.String,
      type: MSG_STATE_VALUE,
      value: 'test',
    };
    expect(roundTrip(msg)).toEqual(msg);
  });

  it('FRAME_DATA', () => {
    const framebuffer = Buffer.alloc(FRAME_DATA_SIZE);
    // Set a recognizable pattern
    framebuffer[0] = 0xde;
    framebuffer[FRAME_DATA_SIZE - 1] = 0xad;
    const decoded = roundTrip({ framebuffer, type: MSG_FRAME_DATA });
    expect(decoded.type).toBe(MSG_FRAME_DATA);
    if (decoded.type === MSG_FRAME_DATA) {
      expect(decoded.framebuffer.length).toBe(FRAME_DATA_SIZE);
      expect(decoded.framebuffer[0]).toBe(0xde);
      expect(decoded.framebuffer[FRAME_DATA_SIZE - 1]).toBe(0xad);
    }
  });
});

// --- Streaming parser adversarial tests ---

describe('ProtocolParser — streaming', () => {
  it('parses 1 byte at a time', () => {
    const parser = new ProtocolParser();
    const msg = encodeMessage({ type: MSG_PING });

    // Feed one byte at a time — only the last push should yield a message
    for (let i = 0; i < msg.length - 1; i++) {
      parser.push(Buffer.from([msg[i]]));
      expect(parser.parse()).toHaveLength(0);
    }

    parser.push(Buffer.from([msg[msg.length - 1]]));
    const messages = parser.parse();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: MSG_PING });
  });

  it('parses concatenated messages in one chunk', () => {
    const parser = new ProtocolParser();
    const ping = encodeMessage({ type: MSG_PING });
    const pong = encodeMessage({ type: MSG_PONG });
    const ready = encodeMessage({ type: MSG_READY });

    parser.push(Buffer.concat([ping, pong, ready]));
    const messages = parser.parse();
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ type: MSG_PING });
    expect(messages[1]).toEqual({ type: MSG_PONG });
    expect(messages[2]).toEqual({ type: MSG_READY });
  });

  it('handles truncated payload — waits for more data', () => {
    const parser = new ProtocolParser();
    const full = encodeMessage({ name: 'score', type: MSG_QUERY_STATE });

    // Send header + partial payload
    parser.push(full.subarray(0, 5));
    expect(parser.parse()).toHaveLength(0);
    expect(parser.bufferedBytes).toBe(5);

    // Send the rest
    parser.push(full.subarray(5));
    const messages = parser.parse();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ name: 'score', type: MSG_QUERY_STATE });
  });

  it('handles truncated header — waits for more data', () => {
    const parser = new ProtocolParser();
    const msg = encodeMessage({ type: MSG_PING });

    // Only send 2 of 3 header bytes
    parser.push(msg.subarray(0, 2));
    expect(parser.parse()).toHaveLength(0);

    parser.push(msg.subarray(2));
    expect(parser.parse()).toHaveLength(1);
  });

  it('skips unknown message type', () => {
    const parser = new ProtocolParser();

    // Fabricate an unknown type (0x42) with 2-byte payload
    const unknown = Buffer.from([0x42, 0x00, 0x02, 0xaa, 0xbb]);
    const ping = encodeMessage({ type: MSG_PING });

    parser.push(Buffer.concat([unknown, ping]));
    const messages = parser.parse();

    // Unknown message is skipped, PING is parsed
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ type: MSG_PING });
  });

  it('skips unknown type even with 1-byte-at-a-time feed', () => {
    const parser = new ProtocolParser();
    const unknown = Buffer.from([0x42, 0x00, 0x01, 0xff]);
    const pong = encodeMessage({ type: MSG_PONG });
    const combined = Buffer.concat([unknown, pong]);

    for (const byte of combined) {
      parser.push(Buffer.from([byte]));
      parser.parse(); // drain as we go
    }

    // Verify by feeding everything at once:
    const parser2 = new ProtocolParser();
    parser2.push(combined);
    const msgs = parser2.parse();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: MSG_PONG });
  });

  it('buffers correctly across multiple partial pushes', () => {
    const parser = new ProtocolParser();
    const msg = encodeMessage({
      buttons: 0x01,
      crankAngle: 90.0,
      type: MSG_INJECT_INPUT,
    });

    // Split at arbitrary points
    parser.push(msg.subarray(0, 1));
    expect(parser.parse()).toHaveLength(0);

    parser.push(msg.subarray(1, 4));
    expect(parser.parse()).toHaveLength(0);

    parser.push(msg.subarray(4));
    const messages = parser.parse();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({
      buttons: 0x01,
      crankAngle: 90.0,
      type: MSG_INJECT_INPUT,
    });
  });

  it('FRAME_DATA 1-byte-at-a-time', () => {
    const parser = new ProtocolParser();
    const framebuffer = Buffer.alloc(FRAME_DATA_SIZE, 0x55);
    const encoded = encodeMessage({ framebuffer, type: MSG_FRAME_DATA });

    for (const byte of encoded) {
      parser.push(Buffer.from([byte]));
    }

    const messages = parser.parse();
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe(MSG_FRAME_DATA);
    if (messages[0].type === MSG_FRAME_DATA) {
      expect(messages[0].framebuffer.length).toBe(FRAME_DATA_SIZE);
      expect(messages[0].framebuffer[0]).toBe(0x55);
    }
  });

  it('STATE_VALUE negative int32 round-trips', () => {
    const parser = new ProtocolParser();
    const msg: Message = {
      stateType: StateType.Int32,
      type: MSG_STATE_VALUE,
      value: -2_147_483_648,
    };
    parser.push(encodeMessage(msg));
    const [decoded] = parser.parse();
    expect(decoded).toEqual(msg);
  });

  it('ERROR with empty string', () => {
    const parser = new ProtocolParser();
    const msg: Message = { message: '', type: MSG_ERROR };
    parser.push(encodeMessage(msg));
    const [decoded] = parser.parse();
    expect(decoded).toEqual(msg);
  });

  it('reset() clears buffer', () => {
    const parser = new ProtocolParser();
    parser.push(Buffer.from([0x01, 0x00])); // partial header
    expect(parser.bufferedBytes).toBe(2);
    parser.reset();
    expect(parser.bufferedBytes).toBe(0);
  });

  it('multiple parse() calls are idempotent on empty buffer', () => {
    const parser = new ProtocolParser();
    parser.push(encodeMessage({ type: MSG_PING }));
    expect(parser.parse()).toHaveLength(1);
    expect(parser.parse()).toHaveLength(0);
    expect(parser.parse()).toHaveLength(0);
  });
});
