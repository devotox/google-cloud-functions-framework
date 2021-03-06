"use strict";
// Copyright 2019 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Checks whether the incoming request is a CloudEvents event in binary content
 * mode. This is verified by checking the presence of required headers.
 *
 * @link https://github.com/cloudevents/spec/blob/master/http-protocol-binding.md#3-http-message-mapping
 *
 * @param req Express request object.
 * @return True if the request is a CloudEvents event in binary content mode,
 *     false otherwise.
 */
function isBinaryCloudEvent(req) {
    return !!(req.header('ce-type') &&
        req.header('ce-specversion') &&
        req.header('ce-source') &&
        req.header('ce-id'));
}
exports.isBinaryCloudEvent = isBinaryCloudEvent;
/**
 * Returns a CloudEvents context from the given CloudEvents request. Context
 * attributes are retrieved from request headers.
 *
 * @param req Express request object.
 * @return CloudEvents context.
 */
function getBinaryCloudEventContext(req) {
    const context = {};
    for (const name in req.headers) {
        if (name.startsWith('ce-')) {
            const attributeName = name.substr('ce-'.length);
            context[attributeName] = req.header(name);
        }
    }
    return context;
}
exports.getBinaryCloudEventContext = getBinaryCloudEventContext;
//# sourceMappingURL=cloudevents.js.map