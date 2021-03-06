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
// Node.js server that runs user's code on HTTP request. HTTP response is sent
// once user's function has completed.
// The server accepts following HTTP requests:
//   - POST '/*' for executing functions (only for servers handling functions
//     with non-HTTP trigger).
//   - ANY (all methods) '/*' for executing functions (only for servers handling
//     functions with HTTP trigger).
const bodyParser = require("body-parser");
// eslint-disable-next-line node/no-deprecated-api
const domain = require("domain");
const express = require("express");
const http = require("http");
const onFinished = require("on-finished");
const types_1 = require("./types");
const logger_1 = require("./logger");
const cloudevents_1 = require("./cloudevents");
var SignatureType;
(function (SignatureType) {
    SignatureType["HTTP"] = "http";
    SignatureType["EVENT"] = "event";
    SignatureType["CLOUDEVENT"] = "cloudevent";
})(SignatureType = exports.SignatureType || (exports.SignatureType = {}));
// Response object for the most recent request.
let latestRes = null;
/**
 * Sends back a response to the incoming request.
 * @param result Output from function execution.
 * @param err Error from function execution.
 * @param res Express response object.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sendResponse(result, err, res) {
    if (err) {
        res.set(types_1.FUNCTION_STATUS_HEADER_FIELD, 'error');
        // Sending error message back is fine for Pub/Sub-based functions as they do
        // not reach the caller anyway.
        res.send(err.message);
        return;
    }
    if (typeof result === 'undefined' || result === null) {
        res.sendStatus(204); // No Content
    }
    else if (typeof result === 'number') {
        // This isn't technically compliant but numbers otherwise cause us to set
        // the status code to that number instead of sending the number as a body.
        res.json(result);
    }
    else {
        try {
            res.send(result);
        }
        catch (sendErr) {
            // If a customer passes a non-serializeable object (e.g. one with a cycle)
            // then res.send will throw. Customers don't always put a lot of thought
            // into the return value because it's currently only used for
            // CallFunction. The most sane resolution here is to succeed the function
            // (this was the customer's clear intent) but send a 204 (NO CONTENT) and
            // log an error message explaining why their content wasn't sent.
            console.error('Error serializing return value: ' + sendErr.toString());
            res.sendStatus(204); // No Content
        }
    }
}
/**
 * Wraps the provided function into an Express handler function with additional
 * instrumentation logic.
 * @param execute Runs user's function.
 * @return An Express handler function.
 */
function makeHttpHandler(execute) {
    return (req, res) => {
        const d = domain.create();
        // Catch unhandled errors originating from this request.
        d.on('error', err => {
            if (res.locals.functionExecutionFinished) {
                console.error(`Exception from a finished function: ${err}`);
            }
            else {
                res.locals.functionExecutionFinished = true;
                logger_1.sendCrashResponse({ err, res });
            }
        });
        d.run(() => {
            process.nextTick(() => {
                execute(req, res);
            });
        });
    };
}
/**
 * Wraps cloudevent function (or cloudevent function with callback) in HTTP
 * function signature.
 * @param userFunction User's function.
 * @return HTTP function which wraps the provided event function.
 */
function wrapCloudEventFunction(userFunction) {
    return (req, res) => {
        const callback = process.domain.bind(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err, result) => {
            if (res.locals.functionExecutionFinished) {
                console.log('Ignoring extra callback call');
            }
            else {
                res.locals.functionExecutionFinished = true;
                if (err) {
                    console.error(err.stack);
                }
                sendResponse(result, err, res);
            }
        });
        let cloudevent = req.body;
        if (cloudevents_1.isBinaryCloudEvent(req)) {
            cloudevent = cloudevents_1.getBinaryCloudEventContext(req);
            cloudevent.data = req.body;
        }
        // Callback style if user function has more than 2 arguments.
        if (userFunction.length > 2) {
            const fn = userFunction;
            return fn(cloudevent, callback);
        }
        const fn = userFunction;
        Promise.resolve()
            .then(() => {
            const result = fn(cloudevent);
            return result;
        })
            .then(result => {
            callback(null, result);
        }, err => {
            callback(err, undefined);
        });
    };
}
/**
 * Wraps event function (or event function with callback) in HTTP function
 * signature.
 * @param userFunction User's function.
 * @return HTTP function which wraps the provided event function.
 */
function wrapEventFunction(userFunction) {
    return (req, res) => {
        const event = req.body;
        const callback = process.domain.bind(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err, result) => {
            if (res.locals.functionExecutionFinished) {
                console.log('Ignoring extra callback call');
            }
            else {
                res.locals.functionExecutionFinished = true;
                if (err) {
                    console.error(err.stack);
                }
                sendResponse(result, err, res);
            }
        });
        let data = event.data;
        let context = event.context;
        if (cloudevents_1.isBinaryCloudEvent(req)) {
            // Support CloudEvents in binary content mode, with data being the whole
            // request body and context attributes retrieved from request headers.
            data = event;
            context = cloudevents_1.getBinaryCloudEventContext(req);
        }
        else if (context === undefined) {
            // Support legacy events and CloudEvents in structured content mode, with
            // context properties represented as event top-level properties.
            // Context is everything but data.
            context = event;
            // Clear the property before removing field so the data object
            // is not deleted.
            context.data = undefined;
            delete context.data;
        }
        // Callback style if user function has more than 2 arguments.
        if (userFunction.length > 2) {
            const fn = userFunction;
            return fn(data, context, callback);
        }
        const fn = userFunction;
        Promise.resolve()
            .then(() => {
            const result = fn(data, context);
            return result;
        })
            .then(result => {
            callback(null, result);
        }, err => {
            callback(err, undefined);
        });
    };
}
/**
 * Registers handler functions for route paths.
 * @param app Express application object.
 * @param userFunction User's function.
 * @param functionSignatureType Type of user's function signature.
 */
function registerFunctionRoutes(app, userFunction, functionSignatureType) {
    if (functionSignatureType === SignatureType.HTTP) {
        app.use('/favicon.ico|/robots.txt', (req, res) => {
            // Neither crawlers nor browsers attempting to pull the icon find the body
            // contents particularly useful, so we send nothing in the response body.
            res.status(404).send(null);
        });
        app.use('/*', (req, res, next) => {
            onFinished(res, (err, res) => {
                res.locals.functionExecutionFinished = true;
            });
            next();
        });
        app.all('/*', (req, res, next) => {
            const handler = makeHttpHandler(userFunction);
            handler(req, res, next);
        });
    }
    else if (functionSignatureType === SignatureType.EVENT) {
        app.post('/*', (req, res, next) => {
            const wrappedUserFunction = wrapEventFunction(userFunction);
            const handler = makeHttpHandler(wrappedUserFunction);
            handler(req, res, next);
        });
    }
    else {
        app.post('/*', (req, res, next) => {
            const wrappedUserFunction = wrapCloudEventFunction(userFunction);
            const handler = makeHttpHandler(wrappedUserFunction);
            handler(req, res, next);
        });
    }
}
// Use an exit code which is unused by Node.js:
// https://nodejs.org/api/process.html#process_exit_codes
const killInstance = process.exit.bind(process, 16);
/**
 * Enables registration of error handlers.
 * @param server HTTP server which invokes user's function.
 * @constructor
 */
class ErrorHandler {
    constructor(server) {
        this.server = server;
        this.server = server;
    }
    /**
     * Registers handlers for uncaught exceptions and other unhandled errors.
     */
    register() {
        process.on('uncaughtException', err => {
            console.error('Uncaught exception');
            logger_1.sendCrashResponse({ err, res: latestRes, callback: killInstance });
        });
        process.on('unhandledRejection', err => {
            console.error('Unhandled rejection');
            logger_1.sendCrashResponse({ err, res: latestRes, callback: killInstance });
        });
        process.on('exit', code => {
            logger_1.sendCrashResponse({
                err: new Error(`Process exited with code ${code}`),
                res: latestRes,
                silent: code === 0,
            });
        });
        ['SIGINT', 'SIGTERM'].forEach(signal => {
            process.on(signal, () => {
                console.log(`Received ${signal}`);
                this.server.close(() => {
                    // eslint-disable-next-line no-process-exit
                    process.exit();
                });
            });
        });
    }
}
exports.ErrorHandler = ErrorHandler;
/**
 * Creates and configures an Express application and returns an HTTP server
 * which will run it.
 * @param userFunction User's function.
 * @param functionSignatureType Type of user's function signature.
 * @return HTTP server.
 */
function getServer(userFunction, functionSignatureType) {
    // App to use for function executions.
    const app = express();
    // Express middleware
    // Set request-specific values in the very first middleware.
    app.use('/*', (req, res, next) => {
        latestRes = res;
        res.locals.functionExecutionFinished = false;
        next();
    });
    /**
     * Retains a reference to the raw body buffer to allow access to the raw body
     * for things like request signature validation.  This is used as the "verify"
     * function in body-parser options.
     * @param req Express request object.
     * @param res Express response object.
     * @param buf Buffer to be saved.
     */
    // function rawBodySaver(req, res, buf) {
    //     req.rawBody = buf;
    // }
    // // Set limit to a value larger than 32MB, which is maximum limit of higher
    // // level layers anyway.
    // const requestLimit = '1024mb';
    // const defaultBodySavingOptions = {
    //     limit: requestLimit,
    //     verify: rawBodySaver,
    // };
    // const cloudEventsBodySavingOptions = {
    //     type: 'application/cloudevents+json',
    //     limit: requestLimit,
    //     verify: rawBodySaver,
    // };
    // const rawBodySavingOptions = {
    //     limit: requestLimit,
    //     verify: rawBodySaver,
    //     type: '*/*',
    // };
    // // Use extended query string parsing for URL-encoded bodies.
    // const urlEncodedOptions = {
    //     limit: requestLimit,
    //     verify: rawBodySaver,
    //     extended: true,
    // };
    // // Apply middleware
    // app.use(bodyParser.json(cloudEventsBodySavingOptions));
    // app.use(bodyParser.json(defaultBodySavingOptions));
    // app.use(bodyParser.text(defaultBodySavingOptions));
    // app.use(bodyParser.urlencoded(urlEncodedOptions));
    // // The parser will process ALL content types so MUST come last.
    // // Subsequent parsers will be skipped when one is matched.
    // app.use(bodyParser.raw(rawBodySavingOptions));
    // app.enable('trust proxy'); // To respect X-Forwarded-For header.
    registerFunctionRoutes(app, userFunction, functionSignatureType);
    return http.createServer(app);
}
exports.getServer = getServer;
//# sourceMappingURL=invoker.js.map