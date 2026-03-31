# Makefile for pdk_e2e C module
#
# Targets:
#   make test    — compile and run unit tests (no Playdate SDK needed)
#   make format  — format C files with clang-format
#   make lint    — lint C files with clang-tidy
#   make clean   — remove build artifacts

CC      ?= cc
CFLAGS  := -std=c11 -Wall -Wextra -Wpedantic -Werror

# LLVM toolchain — prefer Homebrew LLVM, fall back to system PATH
LLVM_BIN     := $(shell [ -d /opt/homebrew/opt/llvm/bin ] && echo /opt/homebrew/opt/llvm/bin || echo "")
CLANG_FORMAT := $(if $(LLVM_BIN),$(LLVM_BIN)/clang-format,clang-format)
CLANG_TIDY   := $(if $(LLVM_BIN),$(LLVM_BIN)/clang-tidy,clang-tidy)

# Source files at repo root
ROOT    := ..
SRC     := $(ROOT)/pdk_e2e.c
HDR     := $(ROOT)/pdk_e2e.h

# Test configuration — uses stub headers instead of real SDK
TEST_SRC     := tests/test_protocol.c
TEST_BIN     := tests/test_protocol
TEST_INCLUDES := -Itests/stubs -I$(ROOT)
TEST_DEFINES  := -DTARGET_SIMULATOR=1 -DPDK_E2E_TESTING

.PHONY: test format lint clean

test: $(TEST_BIN)
	./$(TEST_BIN)

$(TEST_BIN): $(TEST_SRC) $(SRC) $(HDR) tests/stubs/pd_api.h
	$(CC) $(CFLAGS) $(TEST_DEFINES) $(TEST_INCLUDES) -o $@ $(TEST_SRC) $(SRC) -lm

format:
	$(CLANG_FORMAT) -i $(ROOT)/pdk_e2e.h $(ROOT)/pdk_e2e.c $(TEST_SRC)

lint:
	$(CLANG_TIDY) $(ROOT)/pdk_e2e.h $(ROOT)/pdk_e2e.c -- $(TEST_DEFINES) $(TEST_INCLUDES)

clean:
	rm -f $(TEST_BIN)
