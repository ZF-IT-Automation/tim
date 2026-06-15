"use strict";
// TIM Core Types — v0.1.0-alpha
// These types define the contract that all modules must implement.
Object.defineProperty(exports, "__esModule", { value: true });
exports.evaluateLoadGate = exports.timSessionCachePath = exports.resolveActiveSessionId = exports.readTimSessionCache = exports.hooksEnabled = exports.normalizeHookScripts = exports.getTimDir = exports.getConfigPath = exports.saveConfig = exports.loadConfig = exports.InProcessEventBus = exports.stripDeprecatedTags = exports.isDeprecatedTag = exports.DEPRECATED_TAGS = exports.DEPRECATED_PRIORITY_TAGS = exports.DEPRECATED_STATUS_TAGS = exports.normalizeLegacyTypeTag = exports.isMetadataType = exports.isBuiltinType = exports.isBuiltinMetadataType = exports.METADATA_TYPES = exports.ALL_METADATA_TYPES = exports.LEGACY_METADATA_TYPES = exports.BUILTIN_TYPES = exports.BUILTIN_METADATA_TYPES = void 0;
var types_js_1 = require("./types.js");
Object.defineProperty(exports, "BUILTIN_METADATA_TYPES", { enumerable: true, get: function () { return types_js_1.BUILTIN_METADATA_TYPES; } });
Object.defineProperty(exports, "BUILTIN_TYPES", { enumerable: true, get: function () { return types_js_1.BUILTIN_TYPES; } });
Object.defineProperty(exports, "LEGACY_METADATA_TYPES", { enumerable: true, get: function () { return types_js_1.LEGACY_METADATA_TYPES; } });
Object.defineProperty(exports, "ALL_METADATA_TYPES", { enumerable: true, get: function () { return types_js_1.ALL_METADATA_TYPES; } });
Object.defineProperty(exports, "METADATA_TYPES", { enumerable: true, get: function () { return types_js_1.METADATA_TYPES; } });
Object.defineProperty(exports, "isBuiltinMetadataType", { enumerable: true, get: function () { return types_js_1.isBuiltinMetadataType; } });
Object.defineProperty(exports, "isBuiltinType", { enumerable: true, get: function () { return types_js_1.isBuiltinType; } });
Object.defineProperty(exports, "isMetadataType", { enumerable: true, get: function () { return types_js_1.isMetadataType; } });
Object.defineProperty(exports, "normalizeLegacyTypeTag", { enumerable: true, get: function () { return types_js_1.normalizeLegacyTypeTag; } });
Object.defineProperty(exports, "DEPRECATED_STATUS_TAGS", { enumerable: true, get: function () { return types_js_1.DEPRECATED_STATUS_TAGS; } });
Object.defineProperty(exports, "DEPRECATED_PRIORITY_TAGS", { enumerable: true, get: function () { return types_js_1.DEPRECATED_PRIORITY_TAGS; } });
Object.defineProperty(exports, "DEPRECATED_TAGS", { enumerable: true, get: function () { return types_js_1.DEPRECATED_TAGS; } });
Object.defineProperty(exports, "isDeprecatedTag", { enumerable: true, get: function () { return types_js_1.isDeprecatedTag; } });
Object.defineProperty(exports, "stripDeprecatedTags", { enumerable: true, get: function () { return types_js_1.stripDeprecatedTags; } });
var event_bus_js_1 = require("./event-bus.js");
Object.defineProperty(exports, "InProcessEventBus", { enumerable: true, get: function () { return event_bus_js_1.InProcessEventBus; } });
var config_js_1 = require("./config.js");
Object.defineProperty(exports, "loadConfig", { enumerable: true, get: function () { return config_js_1.loadConfig; } });
Object.defineProperty(exports, "saveConfig", { enumerable: true, get: function () { return config_js_1.saveConfig; } });
Object.defineProperty(exports, "getConfigPath", { enumerable: true, get: function () { return config_js_1.getConfigPath; } });
Object.defineProperty(exports, "getTimDir", { enumerable: true, get: function () { return config_js_1.getTimDir; } });
Object.defineProperty(exports, "normalizeHookScripts", { enumerable: true, get: function () { return config_js_1.normalizeHookScripts; } });
Object.defineProperty(exports, "hooksEnabled", { enumerable: true, get: function () { return config_js_1.hooksEnabled; } });
var session_cache_js_1 = require("./session-cache.js");
Object.defineProperty(exports, "readTimSessionCache", { enumerable: true, get: function () { return session_cache_js_1.readTimSessionCache; } });
Object.defineProperty(exports, "resolveActiveSessionId", { enumerable: true, get: function () { return session_cache_js_1.resolveActiveSessionId; } });
Object.defineProperty(exports, "timSessionCachePath", { enumerable: true, get: function () { return session_cache_js_1.timSessionCachePath; } });
var load_gate_js_1 = require("./load-gate.js");
Object.defineProperty(exports, "evaluateLoadGate", { enumerable: true, get: function () { return load_gate_js_1.evaluateLoadGate; } });
//# sourceMappingURL=index.js.map