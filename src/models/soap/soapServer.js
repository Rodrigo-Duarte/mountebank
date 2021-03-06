'use strict';

var http = require('http'),
    Q = require('q'),
    baseLogger = require('winston'),
    ScopedLogger = require('../../util/scopedLogger'),
    StubResolver = require('../stubResolver'),
    StubRepository = require('../stubRepository'),
    util = require('util'),
    helpers = require('../../util/helpers'),
    combinators = require('../../util/combinators'),
    HttpProxy = require('../http/httpProxy'),
    DryRunValidator = require('../dryRunValidator'),
    Domain = require('domain'),
    errors = require('../../util/errors'),
    soapRequest = require('./soapRequest'),
    WSDL = require('./wsdl');

function createResponse (wsdl, stub, request) {
    var deferred = Q.defer(),
        response = {
            http: {
                // Default to one way message exchange pattern
                statusCode: 202,
                body: '',
                headers: stub.headers || {}
            },
            response: stub.response || {}
        };

    response.http.headers.connection = 'close';

    if (wsdl.isEmpty()) {
        deferred.resolve(response);
    }
    else {
        wsdl.createBodyFor({ stub: stub, request: request, namespacePrefix: 'mb' }).then(function (body) {
            response.http.statusCode = 200;
            response.http.body = util.format(
                '<soapenv:Envelope xmlns:mb="%s" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">\n' +
                '   <soapenv:Header/>\n' +
                '   <soapenv:Body>%s</soapenv:Body>\n' +
                '</soapenv:Envelope>', request.method.URI, body);
            deferred.resolve(response);
        });
    }
    return deferred.promise;
}

function scopeFor (port, name) {
    var scope = util.format('soap:%s', port);
    if (name) {
        scope += ' ' + name;
    }
    return scope;
}

function logConnection (logger, socket) {
    var name = helpers.socketName(socket);

    logger.debug('%s ESTABLISHED', name);

    socket.on('error', function (error) {
        logger.error('%s transmission error X=> %s', name, JSON.stringify(error));
    });

    socket.on('end', function () { logger.debug('%s LAST-ACK', name); });
    socket.on('close', function () { logger.debug('%s CLOSED', name); });
}

/**
 * Spins up a server listening on a socket
 * @param options - the JSON request body for the imposter create request
 * @param recordRequests - the inverse of the --nomock command line parameter
 */
function createServer (options, recordRequests) {
    var deferred = Q.defer(),
        requests = [],
        logger = ScopedLogger.create(baseLogger, scopeFor(options.port)),
        proxy = HttpProxy.create(logger),
        wsdl = WSDL.parse(options.wsdl),
        postProcess = combinators.curry(createResponse, wsdl),
        resolver = StubResolver.create(proxy, postProcess),
        stubs = StubRepository.create(resolver, recordRequests, 'utf8'),
        server = http.createServer(),
        connectionLogger = combinators.curry(logConnection, logger);

    server.on('connection', connectionLogger);

    server.on('request', function (request, response) {
        var domain = Domain.create(),
            clientName = helpers.socketName(request.socket),
            errorHandler = function (error) {
                logger.error('%s X=> %s', clientName, JSON.stringify(errors.details(error)));
                server.errorHandler(errors.details(error), { request: request, response: response });
            };

        logger.info('%s => %s %s', clientName, request.method, request.url);

        domain.on('error', errorHandler);
        domain.run(function () {
            soapRequest.createFrom(request).then(function (simpleRequest) {
                logger.info('%s => %s', clientName, simpleRequest.method);
                logger.debug('%s => %s', clientName, JSON.stringify(simpleRequest));
                if (recordRequests) {
                    requests.push(simpleRequest);
                }

                return stubs.resolve(simpleRequest, logger.withScope(helpers.socketName(request.socket)));
            }).then(function (stubResponse) {
                response.writeHead(stubResponse.http.statusCode, stubResponse.http.headers);
                response.end(stubResponse.http.body, 'utf8');
                return stubResponse;
            }).done(function (response) {
                logger.debug('%s <= %s', clientName, JSON.stringify(response));
            }, errorHandler);
        });
    });

    server.listen(options.port || 0, function () {
        var actualPort = server.address().port,
            metadata = {};

        if (options.name) {
            metadata.name = options.name;
        }

        if (options.port !== actualPort) {
            logger.changeScope(scopeFor(actualPort));
        }

        logger.info('Open for business...');

        deferred.resolve({
            requests: requests,
            addStub: stubs.addStub,
            stubs: stubs.stubs,
            metadata: metadata,
            port: actualPort,
            close: function () {
                server.close();
                logger.info ('Ciao for now');
            }
        });
    });

    return deferred.promise;
}

function initialize (allowInjection, recordRequests) {
    return {
        name: 'soap',
        create: function (request) {
            return createServer(request, recordRequests);
        },
        Validator: {
            create: function () {
                return DryRunValidator.create({
                    StubRepository: StubRepository,
                    testRequest: {
                        requestFrom: '',
                        method: 'GET',
                        path: '/',
                        query: {},
                        headers: {},
                        body: ''
                    },
                    allowInjection: allowInjection
                });
            }
        }
    };
}

module.exports = {
    initialize: initialize
};
