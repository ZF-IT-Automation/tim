"use strict";
// TIM Store — package exports
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIGRATIONS = exports.getCurrentVersion = exports.runMigrations = exports.TimStore = void 0;
var store_js_1 = require("./store.js");
Object.defineProperty(exports, "TimStore", { enumerable: true, get: function () { return store_js_1.TimStore; } });
var schema_js_1 = require("./schema.js");
Object.defineProperty(exports, "runMigrations", { enumerable: true, get: function () { return schema_js_1.runMigrations; } });
Object.defineProperty(exports, "getCurrentVersion", { enumerable: true, get: function () { return schema_js_1.getCurrentVersion; } });
Object.defineProperty(exports, "MIGRATIONS", { enumerable: true, get: function () { return schema_js_1.MIGRATIONS; } });
//# sourceMappingURL=index.js.map