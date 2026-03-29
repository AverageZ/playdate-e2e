// Wire protocol constants and types for playdate-e2e.
// Spec: README.md "Wire Protocol" section.

// --- Message type bytes ---

// Commands (runner -> game)
export const MSG_PING = 0x01;
export const MSG_CAPTURE_FRAME = 0x02;
export const MSG_INJECT_INPUT = 0x03;
export const MSG_QUERY_STATE = 0x04;
export const MSG_RELEASE_INPUT = 0x05;

// Responses (game -> runner)
export const MSG_PONG = 0x81;
export const MSG_FRAME_DATA = 0x82;
export const MSG_INPUT_ACK = 0x83;
export const MSG_STATE_VALUE = 0x84;
export const MSG_STATE_NOT_FOUND = 0x85;
export const MSG_READY = 0xfe;
export const MSG_ERROR = 0xff;

// --- Framing ---

/** [1B type][2B payload length BE][payload] */
export const HEADER_SIZE = 3;

/** Maximum payload size (uint16 max) */
export const MAX_PAYLOAD_SIZE = 0xffff;

/** Framebuffer: 52 bytes/row x 240 rows */
export const FRAME_DATA_SIZE = 12_480;

// --- Enums ---

export enum PlaydateButton {
  A = 0x01,
  B = 0x02,
  Up = 0x04,
  Down = 0x08,
  Left = 0x10,
  Right = 0x20,
}

export enum StateType {
  Int32 = 0,
  Float32 = 1,
  String = 2,
}

/** Sentinel: no crank injection — pass through real hardware angle */
export const CRANK_NO_INJECT = -1.0;

// --- Message types (discriminated union) ---

export type Message =
  | { type: typeof MSG_PING }
  | { type: typeof MSG_PONG }
  | { type: typeof MSG_CAPTURE_FRAME }
  | { type: typeof MSG_RELEASE_INPUT }
  | { type: typeof MSG_INPUT_ACK }
  | { type: typeof MSG_READY }
  | { type: typeof MSG_STATE_NOT_FOUND }
  | { type: typeof MSG_INJECT_INPUT; buttons: number; crankAngle: number }
  | { type: typeof MSG_QUERY_STATE; name: string }
  | { type: typeof MSG_FRAME_DATA; framebuffer: Buffer }
  | {
      type: typeof MSG_STATE_VALUE;
      stateType: StateType;
      value: number | string;
    }
  | { type: typeof MSG_ERROR; message: string };
