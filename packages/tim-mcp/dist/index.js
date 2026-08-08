"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatProjectOutput = exports.toolInputSchema = exports.TOOL_DEFS = exports.createMcpServer = exports.createHttpServer = exports.startServer = void 0;
var server_js_1 = require("./server.js");
Object.defineProperty(exports, "startServer", { enumerable: true, get: function () { return server_js_1.startServer; } });
Object.defineProperty(exports, "createHttpServer", { enumerable: true, get: function () { return server_js_1.createHttpServer; } });
Object.defineProperty(exports, "createMcpServer", { enumerable: true, get: function () { return server_js_1.createMcpServer; } });
// Re-exported for `tim viewer`, which lists tools and renders their parameter
// forms from the same registry the server answers ListTools from.
var server_js_2 = require("./server.js");
Object.defineProperty(exports, "TOOL_DEFS", { enumerable: true, get: function () { return server_js_2.TOOL_DEFS; } });
Object.defineProperty(exports, "toolInputSchema", { enumerable: true, get: function () { return server_js_2.toolInputSchema; } });
var project_output_js_1 = require("./project-output.js");
Object.defineProperty(exports, "formatProjectOutput", { enumerable: true, get: function () { return project_output_js_1.formatProjectOutput; } });
//# sourceMappingURL=index.js.map