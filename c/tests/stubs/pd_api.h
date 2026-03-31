/**
 * Minimal Playdate SDK type stubs for compiling pdk_e2e unit tests
 * without the full Playdate SDK.
 *
 * Only defines the types referenced by pdk_e2e.h/pdk_e2e.c.
 * Not a complete or accurate SDK representation — test-only.
 */

#ifndef PD_API_H_STUB
#define PD_API_H_STUB

#include <stdint.h>

typedef unsigned int PDButtons;

// AIDEV-NOTE: These structs are opaque stubs. The test binary never calls
// through pd->system->... or pd->network->..., so function pointers are
// not needed. Only the type names must exist for pdk_e2e.h to compile.

typedef struct PDTCPConnection PDTCPConnection;

typedef void (*PDAccessCallback)(int granted);
typedef void (*PDConnectCallback)(int success);

typedef struct {
    void (*getButtonState)(PDButtons *current, PDButtons *pushed, PDButtons *released);
    float (*getCrankAngle)(void);
    void (*logToConsole)(const char *fmt, ...);
    void (*error)(const char *fmt, ...);
} PlaydateSystem;

typedef struct {
    uint8_t* (*getDisplayFrame)(void);
} PlaydateGraphics;

typedef struct {
    PDTCPConnection* (*newConnection)(void);
    void (*open)(PDTCPConnection *conn, const char *host, int port, PDConnectCallback cb);
    void (*requestAccess)(PDAccessCallback cb);
    int (*getBytesAvailable)(PDTCPConnection *conn);
    int (*read)(PDTCPConnection *conn, void *buf, int len);
    int (*write)(PDTCPConnection *conn, const void *buf, int len);
    void (*close)(PDTCPConnection *conn);
} PlaydateTCP;

typedef struct {
    PlaydateTCP *tcp;
} PlaydateNetwork;

typedef struct PlaydateAPI {
    PlaydateSystem *system;
    PlaydateGraphics *graphics;
    PlaydateNetwork *network;
} PlaydateAPI;

#endif // PD_API_H_STUB
