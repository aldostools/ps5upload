## Payload Third-Party Upgrade Notes

This payload already vendors key libraries:
- `third_party/zstd`
- `lz4.c`
- `third_party/lzma_sdk`
- `third_party/unrar`
- `third_party/xxhash`
- `third_party/blake3`

Recommended upgrade order:
1. `zstd` (performance + stability fixes)
2. `lz4` (hot-path speed fixes)
3. `unrar` (RAR parsing/extraction robustness)
4. `lzma_sdk` (compatibility refresh)

### Hash roadmap

- `HASH_FILE` uses SHA-256 today.
- `HASH_FILE_FAST` uses XXH64 as a fast prefilter hash.
- `HASH_FILE_B3` uses BLAKE3 when both payload and client support it.

### Optional allocator profile

- Build with `MIMALLOC=1` after vendoring mimalloc under `third_party/mimalloc`.
- The makefile auto-falls back to default allocator if mimalloc sources are absent.
