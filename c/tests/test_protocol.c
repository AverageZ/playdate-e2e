/**
 * test_protocol.c — Unit tests for pdk_e2e wire protocol encode/decode
 * and button transition state machine.
 *
 * Uses assert() — no framework dependency. Exits on first failure.
 * Compile with -DPDK_E2E_TESTING -DTARGET_SIMULATOR=1 to expose test helpers.
 *
 * Known byte sequences must match TypeScript protocol.test.ts exactly.
 */

#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "../../pdk_e2e.h"

// Test-only API declared in pdk_e2e.c (compiled with PDK_E2E_TESTING)
extern int pdk_e2e_test_encode_message(uint8_t *out, uint8_t type, const uint8_t *payload,
                                       uint16_t payload_len);
extern bool pdk_e2e_test_try_parse(const uint8_t *buf, uint16_t buf_len, uint8_t *out_type,
                                   uint16_t *out_payload_len, int *out_total_len);
extern int pdk_e2e_test_encode_state_int32(uint8_t *out, int32_t value);
extern int pdk_e2e_test_encode_state_float32(uint8_t *out, float value);
extern int pdk_e2e_test_encode_state_string(uint8_t *out, const char *value);
extern int pdk_e2e_test_encode_error(uint8_t *out, const char *msg);
extern void pdk_e2e_test_set_injected_buttons(PDButtons buttons);
extern void pdk_e2e_test_clear_injection(void);
extern void pdk_e2e_test_snapshot_buttons_no_real(void);
extern void pdk_e2e_test_get_buttons(PDButtons *current, PDButtons *pushed, PDButtons *released);
extern void pdk_e2e_test_reset_button_state(void);
extern void pdk_e2e_test_set_state_query_hook(pdk_e2e_state_query_fn fn);
extern pdk_e2e_state_query_fn pdk_e2e_test_get_state_query_hook(void);
extern void pdk_e2e_test_handle_query_state(const uint8_t *payload, uint16_t payload_len);
extern void pdk_e2e_test_set_fake_pd(PlaydateAPI *fake_pd, PDTCPConnection *fake_conn);

// --- Fake PD for integration tests ---
// Captures bytes sent via pd->network->tcp->write() so we can verify
// handle_query_state produces correct wire responses.

static uint8_t captured_write_buf[4096];
static int captured_write_len = 0;

static int fake_tcp_write(PDTCPConnection *conn, const void *buf, int len) {
    (void)conn;
    if (captured_write_len + len <= (int)sizeof(captured_write_buf)) {
        memcpy(captured_write_buf + captured_write_len, buf, len);
        captured_write_len += len;
    }
    return len;
}

static void fake_log(const char *fmt, ...) {
    (void)fmt;
}

static PlaydateTCP fake_tcp = {.write = fake_tcp_write};
static PlaydateNetwork fake_network = {.tcp = &fake_tcp};
static PlaydateSystem fake_system = {.logToConsole = fake_log, .error = fake_log};
static PlaydateAPI fake_pd = {.system = &fake_system, .network = &fake_network};

static void reset_capture(void) {
    captured_write_len = 0;
    memset(captured_write_buf, 0, sizeof(captured_write_buf));
}

// --- Helpers ---

static int tests_passed = 0;
static int tests_run = 0;

#define TEST(name)                                                                                 \
    do {                                                                                           \
        tests_run++;                                                                               \
        printf("  %s... ", #name);                                                                 \
    } while (0)

#define PASS()                                                                                     \
    do {                                                                                           \
        tests_passed++;                                                                            \
        printf("ok\n");                                                                            \
    } while (0)

static void assert_bytes_eq(const uint8_t *actual, const uint8_t *expected, int len) {
    for (int i = 0; i < len; i++) {
        if (actual[i] != expected[i]) {
            printf("FAIL at byte %d: expected 0x%02x, got 0x%02x\n", i, expected[i], actual[i]);
            printf("  expected: ");
            for (int j = 0; j < len; j++)
                printf("0x%02x ", expected[j]);
            printf("\n  actual:   ");
            for (int j = 0; j < len; j++)
                printf("0x%02x ", actual[j]);
            printf("\n");
            assert(0);
        }
    }
}

// --- Encoding tests ---

static void test_encode_pong(void) {
    TEST(encode_pong);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_message(out, PDK_E2E_MSG_PONG, NULL, 0);
    assert(len == 3);
    uint8_t expected[] = {0x81, 0x00, 0x00};
    assert_bytes_eq(out, expected, 3);
    PASS();
}

static void test_encode_ready(void) {
    TEST(encode_ready);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_message(out, PDK_E2E_MSG_READY, NULL, 0);
    assert(len == 3);
    uint8_t expected[] = {0xFE, 0x00, 0x00};
    assert_bytes_eq(out, expected, 3);
    PASS();
}

static void test_encode_input_ack(void) {
    TEST(encode_input_ack);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_message(out, PDK_E2E_MSG_INPUT_ACK, NULL, 0);
    assert(len == 3);
    uint8_t expected[] = {0x83, 0x00, 0x00};
    assert_bytes_eq(out, expected, 3);
    PASS();
}

static void test_encode_state_not_found(void) {
    TEST(encode_state_not_found);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_message(out, PDK_E2E_MSG_STATE_NOT_FOUND, NULL, 0);
    assert(len == 3);
    uint8_t expected[] = {0x85, 0x00, 0x00};
    assert_bytes_eq(out, expected, 3);
    PASS();
}

static void test_encode_error(void) {
    TEST(encode_error);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_error(out, "msg");
    // [0xFF][0x00, 0x04]['m', 's', 'g', 0x00]
    assert(len == 7);
    uint8_t expected[] = {0xFF, 0x00, 0x04, 'm', 's', 'g', 0x00};
    assert_bytes_eq(out, expected, 7);
    PASS();
}

static void test_encode_error_timeout(void) {
    TEST(encode_error_timeout);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_error(out, "timeout");
    // [0xFF][0x00, 0x08]['t','i','m','e','o','u','t', 0x00]
    assert(len == 11);
    assert(out[0] == 0xFF);
    assert(out[1] == 0x00);
    assert(out[2] == 0x08); // payload = 8 bytes ("timeout" + null)
    assert(memcmp(out + 3, "timeout", 7) == 0);
    assert(out[10] == 0x00);
    PASS();
}

static void test_encode_state_int32(void) {
    TEST(encode_state_int32_42);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_state_int32(out, 42);
    // [0x84][0x00, 0x05][0x00][0x2A, 0x00, 0x00, 0x00]
    assert(len == 8);
    uint8_t expected[] = {0x84, 0x00, 0x05, 0x00, 0x2A, 0x00, 0x00, 0x00};
    assert_bytes_eq(out, expected, 8);
    PASS();
}

static void test_encode_state_int32_negative(void) {
    TEST(encode_state_int32_negative);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_state_int32(out, -100);
    assert(len == 8);
    assert(out[0] == 0x84);
    assert(out[3] == PDK_E2E_STATE_INT32);
    // -100 in int32 LE = 0x9C, 0xFF, 0xFF, 0xFF
    uint8_t expected_val[] = {0x9C, 0xFF, 0xFF, 0xFF};
    assert_bytes_eq(out + 4, expected_val, 4);
    PASS();
}

static void test_encode_state_int32_min(void) {
    TEST(encode_state_int32_min);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_state_int32(out, -2147483648);
    assert(len == 8);
    // INT32_MIN in LE = 0x00, 0x00, 0x00, 0x80
    uint8_t expected_val[] = {0x00, 0x00, 0x00, 0x80};
    assert_bytes_eq(out + 4, expected_val, 4);
    PASS();
}

static void test_encode_state_int32_max(void) {
    TEST(encode_state_int32_max);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_state_int32(out, 2147483647);
    assert(len == 8);
    // INT32_MAX in LE = 0xFF, 0xFF, 0xFF, 0x7F
    uint8_t expected_val[] = {0xFF, 0xFF, 0xFF, 0x7F};
    assert_bytes_eq(out + 4, expected_val, 4);
    PASS();
}

static void test_encode_state_float32(void) {
    TEST(encode_state_float32_90);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_state_float32(out, 90.0f);
    assert(len == 8);
    assert(out[0] == 0x84);
    assert(out[1] == 0x00);
    assert(out[2] == 0x05);
    assert(out[3] == PDK_E2E_STATE_FLOAT32);
    // 90.0 in float32 LE = 0x00, 0x00, 0xB4, 0x42
    uint8_t expected_float[] = {0x00, 0x00, 0xB4, 0x42};
    assert_bytes_eq(out + 4, expected_float, 4);
    PASS();
}

static void test_encode_state_float32_pi(void) {
    TEST(encode_state_float32_pi);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_state_float32(out, 3.14f);
    assert(len == 8);
    assert(out[3] == PDK_E2E_STATE_FLOAT32);
    // Verify round-trip
    float decoded;
    memcpy(&decoded, out + 4, 4);
    assert(fabsf(decoded - 3.14f) < 0.01f);
    PASS();
}

static void test_encode_state_string(void) {
    TEST(encode_state_string_hello);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_state_string(out, "hello");
    // [0x84][0x00, 0x07][0x02]['h','e','l','l','o', 0x00]
    assert(len == 10);
    assert(out[0] == 0x84);
    assert(out[1] == 0x00);
    assert(out[2] == 0x07); // payload = 1 + 5 + 1 = 7
    assert(out[3] == PDK_E2E_STATE_STRING);
    assert(memcmp(out + 4, "hello", 5) == 0);
    assert(out[9] == 0x00);
    PASS();
}

static void test_encode_state_string_abc(void) {
    TEST(encode_state_string_abc);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_state_string(out, "abc");
    // [0x84][0x00, 0x05][0x02]['a','b','c', 0x00]
    assert(len == 8);
    uint8_t expected[] = {0x84, 0x00, 0x05, 0x02, 'a', 'b', 'c', 0x00};
    assert_bytes_eq(out, expected, 8);
    PASS();
}

static void test_encode_frame_data_header(void) {
    TEST(encode_frame_data_header);
    uint8_t out[PDK_E2E_HEADER_SIZE + PDK_E2E_FRAME_DATA_SIZE];
    // Create a fake framebuffer filled with 0xAA
    uint8_t framebuffer[PDK_E2E_FRAME_DATA_SIZE];
    memset(framebuffer, 0xAA, PDK_E2E_FRAME_DATA_SIZE);

    int len = pdk_e2e_test_encode_message(out, PDK_E2E_MSG_FRAME_DATA, framebuffer,
                                          PDK_E2E_FRAME_DATA_SIZE);
    assert(len == PDK_E2E_HEADER_SIZE + PDK_E2E_FRAME_DATA_SIZE);
    assert(out[0] == 0x82);
    // 12480 = 0x30C0 in big-endian
    assert(out[1] == 0x30);
    assert(out[2] == 0xC0);
    // Verify payload matches
    assert(out[3] == 0xAA);
    assert(out[PDK_E2E_HEADER_SIZE + PDK_E2E_FRAME_DATA_SIZE - 1] == 0xAA);
    PASS();
}

// --- Decoding / parsing tests ---

static void test_parse_ping(void) {
    TEST(parse_ping);
    uint8_t buf[] = {0x01, 0x00, 0x00};
    uint8_t type;
    uint16_t payload_len;
    int total_len;
    bool ok = pdk_e2e_test_try_parse(buf, sizeof(buf), &type, &payload_len, &total_len);
    assert(ok);
    assert(type == PDK_E2E_MSG_PING);
    assert(payload_len == 0);
    assert(total_len == 3);
    PASS();
}

static void test_parse_capture_frame(void) {
    TEST(parse_capture_frame);
    uint8_t buf[] = {0x02, 0x00, 0x00};
    uint8_t type;
    uint16_t payload_len;
    int total_len;
    bool ok = pdk_e2e_test_try_parse(buf, sizeof(buf), &type, &payload_len, &total_len);
    assert(ok);
    assert(type == PDK_E2E_MSG_CAPTURE_FRAME);
    assert(payload_len == 0);
    assert(total_len == 3);
    PASS();
}

static void test_parse_release_input(void) {
    TEST(parse_release_input);
    uint8_t buf[] = {0x05, 0x00, 0x00};
    uint8_t type;
    uint16_t payload_len;
    int total_len;
    bool ok = pdk_e2e_test_try_parse(buf, sizeof(buf), &type, &payload_len, &total_len);
    assert(ok);
    assert(type == PDK_E2E_MSG_RELEASE_INPUT);
    assert(payload_len == 0);
    assert(total_len == 3);
    PASS();
}

static void test_parse_inject_input(void) {
    TEST(parse_inject_input);
    // INJECT_INPUT(A|Up=0x05, crank=90.0)
    float angle = 90.0f;
    uint8_t buf[8];
    buf[0] = 0x03;              // type
    buf[1] = 0x00;              // length high
    buf[2] = 0x05;              // length low (5 bytes)
    buf[3] = 0x05;              // buttons = A | Up
    memcpy(buf + 4, &angle, 4); // float32 LE

    uint8_t type;
    uint16_t payload_len;
    int total_len;
    bool ok = pdk_e2e_test_try_parse(buf, sizeof(buf), &type, &payload_len, &total_len);
    assert(ok);
    assert(type == PDK_E2E_MSG_INJECT_INPUT);
    assert(payload_len == 5);
    assert(total_len == 8);
    // Verify payload content
    assert(buf[3] == 0x05); // buttons
    float decoded_angle;
    memcpy(&decoded_angle, buf + 4, 4);
    assert(fabsf(decoded_angle - 90.0f) < 0.001f);
    PASS();
}

static void test_parse_query_state(void) {
    TEST(parse_query_state);
    // QUERY_STATE("score") = [0x04][0x00, 0x06]['s','c','o','r','e', 0x00]
    uint8_t buf[] = {0x04, 0x00, 0x06, 's', 'c', 'o', 'r', 'e', 0x00};
    uint8_t type;
    uint16_t payload_len;
    int total_len;
    bool ok = pdk_e2e_test_try_parse(buf, sizeof(buf), &type, &payload_len, &total_len);
    assert(ok);
    assert(type == PDK_E2E_MSG_QUERY_STATE);
    assert(payload_len == 6);
    assert(total_len == 9);
    // Verify the name string (null-terminated in payload)
    assert(strcmp((const char *)(buf + 3), "score") == 0);
    PASS();
}

// --- Partial read simulation ---

static void test_partial_read_1byte(void) {
    TEST(partial_read_1byte);
    // PING = [0x01, 0x00, 0x00]
    uint8_t ping[] = {0x01, 0x00, 0x00};
    uint8_t type;
    uint16_t payload_len;
    int total_len;

    // Feed 1 byte at a time — should fail until complete
    assert(!pdk_e2e_test_try_parse(ping, 0, &type, &payload_len, &total_len));
    assert(!pdk_e2e_test_try_parse(ping, 1, &type, &payload_len, &total_len));
    assert(!pdk_e2e_test_try_parse(ping, 2, &type, &payload_len, &total_len));
    assert(pdk_e2e_test_try_parse(ping, 3, &type, &payload_len, &total_len));
    assert(type == PDK_E2E_MSG_PING);
    PASS();
}

static void test_partial_read_inject_input(void) {
    TEST(partial_read_inject_input);
    // INJECT_INPUT(A=0x01, crank=45.0)
    float angle = 45.0f;
    uint8_t buf[8];
    buf[0] = 0x03;
    buf[1] = 0x00;
    buf[2] = 0x05;
    buf[3] = 0x01;
    memcpy(buf + 4, &angle, 4);

    uint8_t type;
    uint16_t payload_len;
    int total_len;

    // Partial: header only (3 bytes) — knows payload length but not enough data
    assert(!pdk_e2e_test_try_parse(buf, 3, &type, &payload_len, &total_len));
    // Partial: header + 2 bytes of payload
    assert(!pdk_e2e_test_try_parse(buf, 5, &type, &payload_len, &total_len));
    // Partial: header + 4 bytes of payload
    assert(!pdk_e2e_test_try_parse(buf, 7, &type, &payload_len, &total_len));
    // Complete
    assert(pdk_e2e_test_try_parse(buf, 8, &type, &payload_len, &total_len));
    assert(type == PDK_E2E_MSG_INJECT_INPUT);
    assert(payload_len == 5);
    PASS();
}

static void test_partial_read_query_state(void) {
    TEST(partial_read_query_state);
    uint8_t buf[] = {0x04, 0x00, 0x06, 's', 'c', 'o', 'r', 'e', 0x00};

    uint8_t type;
    uint16_t payload_len;
    int total_len;

    // Incrementally add bytes
    for (uint16_t i = 0; i < sizeof(buf) - 1; i++) {
        assert(!pdk_e2e_test_try_parse(buf, i, &type, &payload_len, &total_len));
    }
    // Full message
    assert(pdk_e2e_test_try_parse(buf, sizeof(buf), &type, &payload_len, &total_len));
    assert(type == PDK_E2E_MSG_QUERY_STATE);
    PASS();
}

// --- Button transition tests ---
// These test the 5 required cases from the README specification.

static void test_button_single_frame_press(void) {
    TEST(button_single_frame_press);
    pdk_e2e_test_reset_button_state();

    // Frame 1: inject A
    pdk_e2e_test_set_injected_buttons(PDK_E2E_BUTTON_A);
    pdk_e2e_test_snapshot_buttons_no_real();

    PDButtons current, pushed, released;
    pdk_e2e_test_get_buttons(&current, &pushed, &released);
    assert(current == PDK_E2E_BUTTON_A);
    assert(pushed == PDK_E2E_BUTTON_A);
    assert(released == 0);

    // Frame 2: no new command — A still held
    pdk_e2e_test_snapshot_buttons_no_real();
    pdk_e2e_test_get_buttons(&current, &pushed, &released);
    assert(current == PDK_E2E_BUTTON_A);
    assert(pushed == 0); // not newly pushed
    assert(released == 0);

    PASS();
}

static void test_button_release(void) {
    TEST(button_release);
    pdk_e2e_test_reset_button_state();

    // Frame 1: inject A
    pdk_e2e_test_set_injected_buttons(PDK_E2E_BUTTON_A);
    pdk_e2e_test_snapshot_buttons_no_real();

    // Frame 2: still held
    pdk_e2e_test_snapshot_buttons_no_real();

    // Frame 3: release (clear injection)
    pdk_e2e_test_clear_injection();
    pdk_e2e_test_snapshot_buttons_no_real();

    PDButtons current, pushed, released;
    pdk_e2e_test_get_buttons(&current, &pushed, &released);
    assert(current == 0);
    assert(pushed == 0);
    assert(released == PDK_E2E_BUTTON_A);

    PASS();
}

static void test_button_swap(void) {
    TEST(button_swap);
    pdk_e2e_test_reset_button_state();

    // Frame 1: inject A
    pdk_e2e_test_set_injected_buttons(PDK_E2E_BUTTON_A);
    pdk_e2e_test_snapshot_buttons_no_real();

    // Frame 2: inject B (swap)
    pdk_e2e_test_set_injected_buttons(PDK_E2E_BUTTON_B);
    pdk_e2e_test_snapshot_buttons_no_real();

    PDButtons current, pushed, released;
    pdk_e2e_test_get_buttons(&current, &pushed, &released);
    assert(current == PDK_E2E_BUTTON_B);
    assert(pushed == PDK_E2E_BUTTON_B);
    assert(released == PDK_E2E_BUTTON_A);

    PASS();
}

static void test_button_multi_partial_release(void) {
    TEST(button_multi_partial_release);
    pdk_e2e_test_reset_button_state();

    // Frame 1: inject A|B
    pdk_e2e_test_set_injected_buttons(PDK_E2E_BUTTON_A | PDK_E2E_BUTTON_B);
    pdk_e2e_test_snapshot_buttons_no_real();

    PDButtons current, pushed, released;
    pdk_e2e_test_get_buttons(&current, &pushed, &released);
    assert(pushed == (PDK_E2E_BUTTON_A | PDK_E2E_BUTTON_B));

    // Frame 2: inject A only (release B)
    pdk_e2e_test_set_injected_buttons(PDK_E2E_BUTTON_A);
    pdk_e2e_test_snapshot_buttons_no_real();

    pdk_e2e_test_get_buttons(&current, &pushed, &released);
    assert(current == PDK_E2E_BUTTON_A);
    assert(pushed == 0); // A was already held — not newly pushed
    assert(released == PDK_E2E_BUTTON_B);

    PASS();
}

static void test_button_noop_reinjection(void) {
    TEST(button_noop_reinjection);
    pdk_e2e_test_reset_button_state();

    // Frame 1: inject A
    pdk_e2e_test_set_injected_buttons(PDK_E2E_BUTTON_A);
    pdk_e2e_test_snapshot_buttons_no_real();

    // Frame 2: still A (advance prev)
    pdk_e2e_test_snapshot_buttons_no_real();

    // Frame 3: inject A again (same state)
    pdk_e2e_test_set_injected_buttons(PDK_E2E_BUTTON_A);
    pdk_e2e_test_snapshot_buttons_no_real();

    PDButtons current, pushed, released;
    pdk_e2e_test_get_buttons(&current, &pushed, &released);
    assert(current == PDK_E2E_BUTTON_A);
    assert(pushed == 0);
    assert(released == 0);

    PASS();
}

// --- Unknown message type ---

static void test_parse_unknown_type(void) {
    TEST(parse_unknown_type);
    // Unknown type 0x42 with 2-byte payload
    uint8_t buf[] = {0x42, 0x00, 0x02, 0xAA, 0xBB};
    uint8_t type;
    uint16_t payload_len;
    int total_len;
    // Parser should still succeed (can determine message boundaries)
    bool ok = pdk_e2e_test_try_parse(buf, sizeof(buf), &type, &payload_len, &total_len);
    assert(ok);
    assert(type == 0x42);
    assert(payload_len == 2);
    assert(total_len == 5);
    PASS();
}

// --- Edge cases ---

static void test_encode_empty_error(void) {
    TEST(encode_empty_error);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_error(out, "");
    // [0xFF][0x00, 0x01][0x00]
    assert(len == 4);
    uint8_t expected[] = {0xFF, 0x00, 0x01, 0x00};
    assert_bytes_eq(out, expected, 4);
    PASS();
}

static void test_encode_state_int32_zero(void) {
    TEST(encode_state_int32_zero);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_state_int32(out, 0);
    assert(len == 8);
    uint8_t expected[] = {0x84, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00};
    assert_bytes_eq(out, expected, 8);
    PASS();
}

static void test_encode_state_string_empty(void) {
    TEST(encode_state_string_empty);
    uint8_t out[64];
    int len = pdk_e2e_test_encode_state_string(out, "");
    // [0x84][0x00, 0x02][0x02][0x00]
    assert(len == 5);
    uint8_t expected[] = {0x84, 0x00, 0x02, 0x02, 0x00};
    assert_bytes_eq(out, expected, 5);
    PASS();
}

// --- Multiple calls to get_buttons in same frame ---

static void test_get_buttons_consistent(void) {
    TEST(get_buttons_consistent_within_frame);
    pdk_e2e_test_reset_button_state();

    pdk_e2e_test_set_injected_buttons(PDK_E2E_BUTTON_A | PDK_E2E_BUTTON_UP);
    pdk_e2e_test_snapshot_buttons_no_real();

    // Call get_buttons multiple times — must return same values
    PDButtons c1, p1, r1, c2, p2, r2;
    pdk_e2e_test_get_buttons(&c1, &p1, &r1);
    pdk_e2e_test_get_buttons(&c2, &p2, &r2);
    assert(c1 == c2);
    assert(p1 == p2);
    assert(r1 == r2);

    PASS();
}

// --- NULL output pointers ---

static void test_get_buttons_null_pointers(void) {
    TEST(get_buttons_null_pointers);
    pdk_e2e_test_reset_button_state();

    pdk_e2e_test_set_injected_buttons(PDK_E2E_BUTTON_A);
    pdk_e2e_test_snapshot_buttons_no_real();

    // Should not crash with NULL pointers
    pdk_e2e_test_get_buttons(NULL, NULL, NULL);

    PDButtons pushed;
    pdk_e2e_test_get_buttons(NULL, &pushed, NULL);
    assert(pushed == PDK_E2E_BUTTON_A);

    PASS();
}

// --- Multi-message buffer ---

static void test_parse_two_messages_back_to_back(void) {
    TEST(parse_two_messages_back_to_back);
    // PING followed by CAPTURE_FRAME in one buffer
    uint8_t buf[] = {
        0x01, 0x00, 0x00, // PING
        0x02, 0x00, 0x00  // CAPTURE_FRAME
    };

    uint8_t type;
    uint16_t payload_len;
    int total_len;

    // Parse first message
    bool ok = pdk_e2e_test_try_parse(buf, sizeof(buf), &type, &payload_len, &total_len);
    assert(ok);
    assert(type == PDK_E2E_MSG_PING);
    assert(total_len == 3);

    // Use total_len to find second message
    ok = pdk_e2e_test_try_parse(buf + total_len, sizeof(buf) - total_len, &type, &payload_len,
                                &total_len);
    assert(ok);
    assert(type == PDK_E2E_MSG_CAPTURE_FRAME);
    assert(total_len == 3);

    PASS();
}

// --- State query hook ---

// Test hook that returns a fixed int32 for "lua_score", not-found otherwise
static pdk_e2e_state_result hook_returns_int32(const char *name) {
    pdk_e2e_state_result r = {.found = false};
    if (strcmp(name, "lua_score") == 0) {
        r.found = true;
        r.type = PDK_E2E_STATE_INT32;
        r.value.i = 99;
    }
    return r;
}

static pdk_e2e_state_result hook_returns_float32(const char *name) {
    pdk_e2e_state_result r = {.found = false};
    if (strcmp(name, "lua_speed") == 0) {
        r.found = true;
        r.type = PDK_E2E_STATE_FLOAT32;
        r.value.f = 3.14f;
    }
    return r;
}

static pdk_e2e_state_result hook_returns_string(const char *name) {
    pdk_e2e_state_result r = {.found = false};
    if (strcmp(name, "lua_name") == 0) {
        r.found = true;
        r.type = PDK_E2E_STATE_STRING;
        r.value.s = "hello";
    }
    return r;
}

static pdk_e2e_state_result hook_returns_not_found(const char *name) {
    (void)name;
    pdk_e2e_state_result r = {.found = false};
    return r;
}

static void test_hook_returns_int32(void) {
    TEST(hook_returns_int32);
    pdk_e2e_test_set_state_query_hook(hook_returns_int32);

    pdk_e2e_state_query_fn fn = pdk_e2e_test_get_state_query_hook();
    assert(fn != NULL);

    pdk_e2e_state_result r = fn("lua_score");
    assert(r.found == true);
    assert(r.type == PDK_E2E_STATE_INT32);
    assert(r.value.i == 99);

    // Unknown name should return not-found
    r = fn("unknown");
    assert(r.found == false);

    pdk_e2e_test_set_state_query_hook(NULL);
    PASS();
}

static void test_hook_returns_float32(void) {
    TEST(hook_returns_float32);
    pdk_e2e_test_set_state_query_hook(hook_returns_float32);

    pdk_e2e_state_query_fn fn = pdk_e2e_test_get_state_query_hook();
    pdk_e2e_state_result r = fn("lua_speed");
    assert(r.found == true);
    assert(r.type == PDK_E2E_STATE_FLOAT32);
    assert(fabsf(r.value.f - 3.14f) < 0.001f);

    pdk_e2e_test_set_state_query_hook(NULL);
    PASS();
}

static void test_hook_returns_string(void) {
    TEST(hook_returns_string);
    pdk_e2e_test_set_state_query_hook(hook_returns_string);

    pdk_e2e_state_query_fn fn = pdk_e2e_test_get_state_query_hook();
    pdk_e2e_state_result r = fn("lua_name");
    assert(r.found == true);
    assert(r.type == PDK_E2E_STATE_STRING);
    assert(strcmp(r.value.s, "hello") == 0);

    pdk_e2e_test_set_state_query_hook(NULL);
    PASS();
}

static void test_hook_returns_not_found(void) {
    TEST(hook_returns_not_found);
    pdk_e2e_test_set_state_query_hook(hook_returns_not_found);

    pdk_e2e_state_query_fn fn = pdk_e2e_test_get_state_query_hook();
    pdk_e2e_state_result r = fn("anything");
    assert(r.found == false);

    pdk_e2e_test_set_state_query_hook(NULL);
    PASS();
}

static void test_hook_null_default(void) {
    TEST(hook_null_default);
    // After clearing, hook should be NULL
    pdk_e2e_test_set_state_query_hook(NULL);
    pdk_e2e_state_query_fn fn = pdk_e2e_test_get_state_query_hook();
    assert(fn == NULL);
    PASS();
}

static void test_hook_set_then_clear(void) {
    TEST(hook_set_then_clear);
    pdk_e2e_test_set_state_query_hook(hook_returns_int32);
    assert(pdk_e2e_test_get_state_query_hook() != NULL);

    pdk_e2e_test_set_state_query_hook(NULL);
    assert(pdk_e2e_test_get_state_query_hook() == NULL);
    PASS();
}

// --- QUERY_STATE integration (hook fallback via handle_query_state) ---
// These tests exercise the full handle_query_state path: C registry miss ->
// hook fallback -> send_message -> captured bytes.

// Build a null-terminated QUERY_STATE payload from a name string.
static uint16_t make_query_payload(uint8_t *out, const char *name) {
    uint16_t len = (uint16_t)(strlen(name) + 1);
    memcpy(out, name, len);
    return len;
}

static void test_handle_query_state_hook_int32(void) {
    TEST(handle_query_state_hook_int32);
    pdk_e2e_test_set_fake_pd(&fake_pd, NULL);
    pdk_e2e_test_set_state_query_hook(hook_returns_int32);
    reset_capture();

    uint8_t payload[64];
    uint16_t plen = make_query_payload(payload, "lua_score");
    pdk_e2e_test_handle_query_state(payload, plen);

    // Expected: [0x84][0x00, 0x05][0x00][99 as LE int32]
    assert(captured_write_len == 3 + 5); // header + payload
    assert(captured_write_buf[0] == PDK_E2E_MSG_STATE_VALUE);
    assert(captured_write_buf[1] == 0x00);
    assert(captured_write_buf[2] == 0x05); // payload len = 5
    assert(captured_write_buf[3] == PDK_E2E_STATE_INT32);
    int32_t val;
    memcpy(&val, &captured_write_buf[4], 4);
    assert(val == 99);

    pdk_e2e_test_set_state_query_hook(NULL);
    PASS();
}

static void test_handle_query_state_hook_float32(void) {
    TEST(handle_query_state_hook_float32);
    pdk_e2e_test_set_fake_pd(&fake_pd, NULL);
    pdk_e2e_test_set_state_query_hook(hook_returns_float32);
    reset_capture();

    uint8_t payload[64];
    uint16_t plen = make_query_payload(payload, "lua_speed");
    pdk_e2e_test_handle_query_state(payload, plen);

    assert(captured_write_len == 3 + 5);
    assert(captured_write_buf[0] == PDK_E2E_MSG_STATE_VALUE);
    assert(captured_write_buf[3] == PDK_E2E_STATE_FLOAT32);
    float fval;
    memcpy(&fval, &captured_write_buf[4], 4);
    assert(fabsf(fval - 3.14f) < 0.001f);

    pdk_e2e_test_set_state_query_hook(NULL);
    PASS();
}

static void test_handle_query_state_hook_string(void) {
    TEST(handle_query_state_hook_string);
    pdk_e2e_test_set_fake_pd(&fake_pd, NULL);
    pdk_e2e_test_set_state_query_hook(hook_returns_string);
    reset_capture();

    uint8_t payload[64];
    uint16_t plen = make_query_payload(payload, "lua_name");
    pdk_e2e_test_handle_query_state(payload, plen);

    // Expected: [0x84][0x00, 0x07][0x02]['h','e','l','l','o', 0x00]
    assert(captured_write_len == 3 + 7); // header + 1B tag + "hello\0"
    assert(captured_write_buf[0] == PDK_E2E_MSG_STATE_VALUE);
    assert(captured_write_buf[3] == PDK_E2E_STATE_STRING);
    assert(strcmp((const char *)&captured_write_buf[4], "hello") == 0);

    pdk_e2e_test_set_state_query_hook(NULL);
    PASS();
}

static void test_handle_query_state_hook_not_found(void) {
    TEST(handle_query_state_hook_not_found);
    pdk_e2e_test_set_fake_pd(&fake_pd, NULL);
    pdk_e2e_test_set_state_query_hook(hook_returns_not_found);
    reset_capture();

    uint8_t payload[64];
    uint16_t plen = make_query_payload(payload, "no_such_key");
    pdk_e2e_test_handle_query_state(payload, plen);

    // Hook returns not-found, so should get STATE_NOT_FOUND (0x85, empty payload)
    assert(captured_write_len == 3);
    assert(captured_write_buf[0] == PDK_E2E_MSG_STATE_NOT_FOUND);
    assert(captured_write_buf[1] == 0x00);
    assert(captured_write_buf[2] == 0x00);

    pdk_e2e_test_set_state_query_hook(NULL);
    PASS();
}

static void test_handle_query_state_no_hook(void) {
    TEST(handle_query_state_no_hook);
    pdk_e2e_test_set_fake_pd(&fake_pd, NULL);
    pdk_e2e_test_set_state_query_hook(NULL);
    reset_capture();

    uint8_t payload[64];
    uint16_t plen = make_query_payload(payload, "anything");
    pdk_e2e_test_handle_query_state(payload, plen);

    // No hook, no C registry match — STATE_NOT_FOUND
    assert(captured_write_len == 3);
    assert(captured_write_buf[0] == PDK_E2E_MSG_STATE_NOT_FOUND);

    pdk_e2e_test_set_state_query_hook(NULL);
    PASS();
}

// --- Main ---

int main(void) {
    printf("=== pdk_e2e protocol tests ===\n\n");

    printf("Encoding:\n");
    test_encode_pong();
    test_encode_ready();
    test_encode_input_ack();
    test_encode_state_not_found();
    test_encode_error();
    test_encode_error_timeout();
    test_encode_state_int32();
    test_encode_state_int32_negative();
    test_encode_state_int32_min();
    test_encode_state_int32_max();
    test_encode_state_int32_zero();
    test_encode_state_float32();
    test_encode_state_float32_pi();
    test_encode_state_string();
    test_encode_state_string_abc();
    test_encode_state_string_empty();
    test_encode_frame_data_header();
    test_encode_empty_error();

    printf("\nDecoding:\n");
    test_parse_ping();
    test_parse_capture_frame();
    test_parse_release_input();
    test_parse_inject_input();
    test_parse_query_state();
    test_parse_unknown_type();
    test_parse_two_messages_back_to_back();

    printf("\nPartial reads:\n");
    test_partial_read_1byte();
    test_partial_read_inject_input();
    test_partial_read_query_state();

    printf("\nButton transitions:\n");
    test_button_single_frame_press();
    test_button_release();
    test_button_swap();
    test_button_multi_partial_release();
    test_button_noop_reinjection();
    test_get_buttons_consistent();
    test_get_buttons_null_pointers();

    printf("\nState query hook:\n");
    test_hook_returns_int32();
    test_hook_returns_float32();
    test_hook_returns_string();
    test_hook_returns_not_found();
    test_hook_null_default();
    test_hook_set_then_clear();

    printf("\nQUERY_STATE integration (hook fallback):\n");
    test_handle_query_state_hook_int32();
    test_handle_query_state_hook_float32();
    test_handle_query_state_hook_string();
    test_handle_query_state_hook_not_found();
    test_handle_query_state_no_hook();

    printf("\n=== %d/%d tests passed ===\n", tests_passed, tests_run);
    return tests_passed == tests_run ? 0 : 1;
}
