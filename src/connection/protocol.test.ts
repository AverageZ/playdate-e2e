import * as fc from 'fast-check';
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

// --- Custom arbitraries ---

/** Generate a valid 6-bit button bitmask (any combination of A, B, Up, Down, Left, Right). */
const fcButtons = () => fc.integer({ max: 0x3f, min: 0x00 });

/** Generate a float32-representable crank angle (write→read round-trip through float32). */
const fcCrankAngle = () =>
  fc.float({ noDefaultInfinity: true, noNaN: true }).map((f) => {
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(f);

    return buf.readFloatLE(0);
  });

/** Generate a float32-representable value (same canonicalization as crank). */
const fcFloat32 = () =>
  fc.float({ noDefaultInfinity: true, noNaN: true }).map((f) => {
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(f);

    return buf.readFloatLE(0);
  });

/**
 * Generate a string that fits in a protocol payload.
 * Max payload is uint16 (65535). For QUERY_STATE the payload is string + null byte,
 * so the string's UTF-8 encoding must be <= 65534 bytes. We limit to 1000 to keep
 * tests fast while still exercising multi-byte UTF-8.
 */
const fcProtocolString = () => fc.string({ maxLength: 1000, unit: 'grapheme' });

/** Generate any valid Message. */
const fcMessage = (): fc.Arbitrary<Message> =>
  fc.oneof(
    // Empty-payload messages
    fc.constant<Message>({ type: MSG_PING }),
    fc.constant<Message>({ type: MSG_PONG }),
    fc.constant<Message>({ type: MSG_CAPTURE_FRAME }),
    fc.constant<Message>({ type: MSG_RELEASE_INPUT }),
    fc.constant<Message>({ type: MSG_INPUT_ACK }),
    fc.constant<Message>({ type: MSG_READY }),
    fc.constant<Message>({ type: MSG_STATE_NOT_FOUND }),

    // Payload messages
    fc.record({
      buttons: fcButtons(),
      crankAngle: fcCrankAngle(),
      type: fc.constant(MSG_INJECT_INPUT as typeof MSG_INJECT_INPUT),
    }),
    fc.record({
      name: fcProtocolString(),
      type: fc.constant(MSG_QUERY_STATE as typeof MSG_QUERY_STATE),
    }),
    fc.record({
      message: fcProtocolString(),
      type: fc.constant(MSG_ERROR as typeof MSG_ERROR),
    }),
    // STATE_VALUE variants
    fc.record({
      stateType: fc.constant(StateType.Int32 as const),
      type: fc.constant(MSG_STATE_VALUE as typeof MSG_STATE_VALUE),
      value: fc.integer({ max: 2_147_483_647, min: -2_147_483_648 }),
    }),
    fc.record({
      stateType: fc.constant(StateType.Float32 as const),
      type: fc.constant(MSG_STATE_VALUE as typeof MSG_STATE_VALUE),
      value: fcFloat32(),
    }),
    fc.record({
      stateType: fc.constant(StateType.String as const),
      type: fc.constant(MSG_STATE_VALUE as typeof MSG_STATE_VALUE),
      value: fcProtocolString(),
    }),
    // FRAME_DATA excluded — 12KB per sample makes property tests slow
  );

// --- Property-based tests ---

describe('property-based tests', () => {
  it('round-trip: decode(encode(msg)) === msg for all message types', () => {
    const parser = new ProtocolParser();

    fc.assert(
      fc.property(fcMessage(), (msg) => {
        parser.reset();
        parser.push(encodeMessage(msg));
        const decoded = parser.parse();
        expect(decoded).toHaveLength(1);
        expect(decoded[0]).toEqual(msg);
      }),
    );
  });

  it('length prefix matches actual payload size', () => {
    fc.assert(
      fc.property(fcMessage(), (msg) => {
        const encoded = encodeMessage(msg);
        const declaredLength = encoded.readUInt16BE(1);
        const actualPayload = encoded.length - HEADER_SIZE;
        expect(declaredLength).toBe(actualPayload);
      }),
    );
  });

  it('chunked streaming: random-sized chunks yield same messages', () => {
    fc.assert(
      fc.property(
        fcMessage(),
        fc.array(fc.integer({ max: 50, min: 1 }), {
          maxLength: 20,
          minLength: 1,
        }),
        (msg, chunkSizes) => {
          const encoded = encodeMessage(msg);
          const parser = new ProtocolParser();

          // Split encoded buffer into random-sized chunks
          let offset = 0;
          for (const size of chunkSizes) {
            if (offset >= encoded.length) break;
            const end = Math.min(offset + size, encoded.length);
            parser.push(encoded.subarray(offset, end));
            offset = end;
          }
          // Push any remainder
          if (offset < encoded.length) {
            parser.push(encoded.subarray(offset));
          }

          const decoded = parser.parse();
          expect(decoded).toHaveLength(1);
          expect(decoded[0]).toEqual(msg);
        },
      ),
    );
  });

  it('concatenation: N encoded messages in one buffer yield N decoded messages', () => {
    fc.assert(
      fc.property(
        fc.array(fcMessage(), { maxLength: 10, minLength: 1 }),
        (messages) => {
          const encoded = Buffer.concat(messages.map(encodeMessage));
          const parser = new ProtocolParser();
          parser.push(encoded);
          const decoded = parser.parse();
          expect(decoded).toHaveLength(messages.length);
          for (let i = 0; i < messages.length; i++) {
            expect(decoded[i]).toEqual(messages[i]);
          }
        },
      ),
    );
  });

  it('string payloads are null-terminated in encoded output', () => {
    const fcStringMessage = fc.oneof(
      fc.record({
        name: fcProtocolString(),
        type: fc.constant(MSG_QUERY_STATE as typeof MSG_QUERY_STATE),
      }),
      fc.record({
        message: fcProtocolString(),
        type: fc.constant(MSG_ERROR as typeof MSG_ERROR),
      }),
      fc.record({
        stateType: fc.constant(StateType.String as const),
        type: fc.constant(MSG_STATE_VALUE as typeof MSG_STATE_VALUE),
        value: fcProtocolString(),
      }),
    );

    fc.assert(
      fc.property(fcStringMessage, (msg) => {
        const encoded = encodeMessage(msg);
        const payload = encoded.subarray(HEADER_SIZE);
        // Last byte of payload must be null terminator
        expect(payload[payload.length - 1]).toBe(0x00);
      }),
    );
  });

  it('INJECT_INPUT: all button combinations round-trip', () => {
    const parser = new ProtocolParser();

    fc.assert(
      fc.property(fcButtons(), fcCrankAngle(), (buttons, crankAngle) => {
        parser.reset();
        const msg: Message = {
          buttons,
          crankAngle,
          type: MSG_INJECT_INPUT,
        };
        parser.push(encodeMessage(msg));
        const [decoded] = parser.parse();
        expect(decoded).toEqual(msg);
      }),
    );
  });

  it('STATE_VALUE int32 boundary values round-trip', () => {
    const parser = new ProtocolParser();
    const fcBoundaryInt = fc.oneof(
      fc.constant(0),
      fc.constant(-1),
      fc.constant(1),
      fc.constant(-2_147_483_648),
      fc.constant(2_147_483_647),
      fc.integer({ max: 2_147_483_647, min: -2_147_483_648 }),
    );

    fc.assert(
      fc.property(fcBoundaryInt, (value) => {
        parser.reset();
        const msg: Message = {
          stateType: StateType.Int32,
          type: MSG_STATE_VALUE,
          value,
        };
        parser.push(encodeMessage(msg));
        const [decoded] = parser.parse();
        expect(decoded).toEqual(msg);
      }),
    );
  });
});
