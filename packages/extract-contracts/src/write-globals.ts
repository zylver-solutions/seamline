// SPDX-License-Identifier: Apache-2.0
/** Known ECMAScript, Node and server/web globals cannot hold a fresh application singleton. */
// Node's globals: https://github.com/nodejs/node/blob/v24.22.0/doc/api/globals.md
// Keep this static: inspecting the analyzer's runtime would change output by Node version.
export const RESERVED_CACHE_KEYS: ReadonlySet<string> = new Set(`
  __proto__ constructor __defineGetter__ __defineSetter__ __lookupGetter__ __lookupSetter__
  hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf
  Infinity NaN undefined globalThis eval isFinite isNaN parseFloat parseInt decodeURI decodeURIComponent
  encodeURI encodeURIComponent escape unescape Object Function Boolean Symbol Error AggregateError EvalError
  RangeError ReferenceError SyntaxError TypeError URIError Number BigInt Math Date String RegExp Array
  Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array Float16Array Float32Array
  Float64Array BigInt64Array BigUint64Array Map Set WeakMap WeakSet ArrayBuffer SharedArrayBuffer Atomics DataView
  JSON WeakRef FinalizationRegistry Iterator AsyncIterator Promise Reflect Proxy Intl WebAssembly Temporal
  process Buffer global console setImmediate clearImmediate setInterval clearInterval setTimeout clearTimeout
  queueMicrotask structuredClone performance fetch navigator localStorage sessionStorage crypto Crypto CryptoKey
  SubtleCrypto TextEncoder TextDecoder TextEncoderStream TextDecoderStream atob btoa URL URLSearchParams URLPattern
  AbortController AbortSignal DOMException MessageChannel MessagePort MessageEvent BroadcastChannel ReadableStream
  ReadableByteStreamController ReadableStreamDefaultController ReadableStreamBYOBReader ReadableStreamBYOBRequest
  ReadableStreamDefaultReader WritableStream WritableStreamDefaultController WritableStreamDefaultWriter
  TransformStream TransformStreamDefaultController ByteLengthQueuingStrategy CountQueuingStrategy CompressionStream
  DecompressionStream Blob File FileReader FormData Headers Request Response Event EventTarget CustomEvent CloseEvent
  EventSource WebSocket Storage Navigator Performance PerformanceEntry PerformanceMark PerformanceMeasure
  PerformanceObserver PerformanceObserverEntryList PerformanceResourceTiming PerformanceNodeTiming
  PerformanceNavigationTiming PerformanceServerTiming PerformancePaintTiming WebSocketStream reportError
  window self document location history screen caches indexedDB name parent top frames opener length closed event origin
  alert confirm prompt postMessage addEventListener removeEventListener dispatchEvent requestAnimationFrame
  cancelAnimationFrame getComputedStyle matchMedia customElements exports module require __dirname __filename
`.trim().split(/\s+/));

/** Shared runtime objects on which the reviewed library summaries depend. */
export const WRITE_INTRINSIC_ROOTS: ReadonlySet<string> = new Set(`
  Object Boolean Symbol Error AggregateError EvalError RangeError ReferenceError SyntaxError TypeError URIError
  Number BigInt Math Date String RegExp Array Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array
  Int32Array Uint32Array Float16Array Float32Array Float64Array BigInt64Array BigUint64Array Map Set WeakMap
  WeakSet ArrayBuffer SharedArrayBuffer Atomics DataView JSON WeakRef FinalizationRegistry Iterator AsyncIterator
  Promise Intl WebAssembly Temporal Buffer URL URLSearchParams URLPattern TextEncoder TextDecoder Headers
  Request Response AbortController AbortSignal
`.trim().split(/\s+/));

export const WRITE_INTRINSIC_DATA: ReadonlySet<string> = new Set(`
  name length NaN POSITIVE_INFINITY NEGATIVE_INFINITY MAX_VALUE MIN_VALUE MAX_SAFE_INTEGER MIN_SAFE_INTEGER
  EPSILON E LN2 LN10 LOG2E LOG10E PI SQRT1_2 SQRT2
`.trim().split(/\s+/));
