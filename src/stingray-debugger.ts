/**
 * Stingray Visual Studio Code Debugger
 * NOTE: Debugging protocal interfaces: https://github.com/Microsoft/vscode-debugadapter-node/blob/master/protocol/src/debugProtocol.ts
 */
import {
    Logger,
    DebugSession, LoggingDebugSession,
    InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, OutputEvent, ContinuedEvent, Event,
    Thread, StackFrame, Scope, Source, Handles, Breakpoint
} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import _ = require('lodash');
import {readFileSync, existsSync as fileExists} from 'fs';
import * as fs from 'fs';
import * as path from 'path';
import {ConsoleConnection} from './console-connection';
import {EngineLauncher} from './launcher';
import * as helpers from './helpers';
import {luaHelpers} from './engine-snippets';
import {IdString} from './idString';

/**
 * This interface should always match the schema found in the stingray-debug extension manifest.
 */
export interface AttachRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** IP of the Stingray engine process to debug */
    ip?: string;
    /** Port of the Stingray engine process to debug, usually 14030-14039 */
    port?: number;
}

/**
 * This interface should always match the schema found in the stingray-debug extension manifest.
 */
export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    /** Stingray binary folder */
    toolchain: string;
    /** Stingray executable name */
    engine_exe: string;
    /** Project settings file path */
    project_file: string;
    /* Full paths of plugin folder to be scanned for additional plugins. (i.e. resource extensions). */
    additional_plugins: string[];
    /** If set, the project will be compiled before being launched. */
    compile?: boolean;
    /** Additional argument fields to be used for debugging */
    command_line_args?: Array<string>;
}

/**
 * Engine debug message.
 * These are usually sent from the engine debugger.
 */
interface EngineEvent {
    type: string,
    message: string,

    // lua_debugger
    line?: number,
    source?: string,
    stack?: object,
    node_index?: number
    requestId?: number
    // message
    level?: string,
    system?: string
    message_type?: string

    // command out
}

class ScopeContent {
    variablesReference: number;
    frameId: number;
    scopeId: string;
    tableVarName: string = null;
    tablePath: Array<number> = null;
    variables: any = null;

    public dataReady () : boolean {
        return this.variables !== null;
    }

    public isTable() : boolean {
        return !!this.tableVarName;
    }

    public getVariables() : any {
        if (!this.dataReady()) {
            throw new Error('Data not ready');
        }

        return this.variables;
    }

    public getVariable(name: string) : any {
        if (!this.dataReady()) {
            throw new Error('Data not ready');
        }

        return _.find(this.variables, variable => variable.name === name);
    }

    public toString() {
        let path = this.tablePath ? this.tablePath.join(',') : "";
        return `Scope[
            id: ${this.variablesReference},
            scopeId: ${this.scopeId},
            tableVarName: ${this.tableVarName},
            tablePath: ${path}
        ]`;
    }
}

class StingrayDebugSession extends DebugSession {

    // we don't support multiple threads, so we can use a hardcoded ID for the default thread
    private static THREAD_ID = 1;

    // since we want to send breakpoint events, we will assign an id to every event
    // so that the frontend can match events with breakpoints.
    private _breakpointId = 1000;

    // Maps from sourceFile to array of Breakpoints
    private _breakpoints = new Map<string, DebugProtocol.Breakpoint[]>();

    // Last call stack when the engine breaks.
    private _callstack: any = null;

    // Cached source roots.
    private _projectFolderMaps = {};

    // Engine web socket connection.
    private _conn: ConsoleConnection = null;

    // Indicates the if the debug adapter is still initializing.
    private _initializing: boolean = false;

    // If true, it means that after loading breakpoints, we will continue the engine evaluation.
    private _waitingForBreakpoints: boolean = false;

    // Deferred response to indicate we are now successfully attached.
    private _attachResponse: DebugProtocol.Response;

    // Cache the last evaluation response.
    private _lastEvalResponse: DebugProtocol.Response;

    // Pool of ids for ScopeContent (table or top level scopes)
    private _variableReferenceId : number = 1;

    // All the ScopeContent (value container) -> table or top level scopes
    private _scopesContent = new Map<number, ScopeContent>();

    // All scopes accessible at the top of the stack (loca, up_values, globals)
    private _topLevelScopes = new Array<ScopeContent>();

    // Pool of id for request made to the debugger
    private _requestId : number = 1;

    // Pending promises for requests on the debugger
    private _requests: Map<number, any> = new Map<number, any>();

    private _idStringSupport : boolean = false;

    private _idStringMap : object;

    /**
     * Creates a new debug adapter that is used for one debug session.
     * We configure the default implementation of a debug adapter here.
     */
    public constructor() {
        super();

        // This debugger uses one-based lines and columns
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);

        /*
        // Where is the good place to init this? And where to get the project path?
        let dummyPath = 'D:\\Auto\\Projects\\Workflows\\Character_project4\\Character_project4';
        this.initIdString(dummyPath);
        */
    }

    /**
     * The 'initialize' request is the first request called by the frontend
     * to interrogate the features the debug adapter provides.
     */
    protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {

        // Set supported features
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsRestartRequest = true;
        response.body.supportsSetVariable = true;

        // TODO: not implemented yet.
        response.body.supportsCompletionsRequest = true;
        // response.body.supportsGotoTargetsRequest = true;

        this.sendResponse(response);
    }

    protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
        // In case the engine is waiting for the debugger, let'S tell him we are ready.
        if (this._waitingForBreakpoints) {
            this._conn.sendDebuggerCommand('continue');
            this._waitingForBreakpoints = false;
        }

        this.sendResponse(response);
    }

    /**
     * Establish a connection with the engine.
     */
    protected connectToEngine(ip: string, port: number, response: DebugProtocol.Response): ConsoleConnection {
        this._conn = new ConsoleConnection(ip, port);

        // Bind connection callbacks
        this._conn.onOpen(this.onEngineConnectionOpened.bind(this, response));
        this._conn.onError(this.onEngineConnectionError.bind(this, response));

        return this._conn;
    }

    /**
     * Launch the engine and then attach to it.
     */
    protected launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
        let toolchainPath = args.toolchain;
        let projectFilePath = args.project_file;
        let engineExe = args.engine_exe;
        // Launch engine
        let launcher = new EngineLauncher({
            tcPath: toolchainPath,
            engineExe: engineExe,
            projectPath: projectFilePath,
            additionalPlugins: args.additional_plugins || [],
            commandLineArgs: args.command_line_args || []
        });
        if (args.compile) {
            this.sendEvent(new OutputEvent(`Compiling data...\r\n`));
            setTimeout(() => {
                let compilerConnection = new ConsoleConnection("127.0.0.1", 14999);
                compilerConnection.onMessage(this.onEngineMessageReceived.bind(this));
            }, 1000);
        }
        launcher.start(args.compile).then(engineProcess => {
            // Tell the user what we are launching.
            this.sendEvent(new OutputEvent(`Launching ${engineProcess.cmdline}...\r\n`));

            // Set startup project root to resolve scripts.
            this._projectFolderMaps["<project>"] = path.dirname(projectFilePath);

            // Add some map folder sources:
            let coreMapFolder = path.join(toolchainPath, 'core');
            if (fileExists(coreMapFolder))
                this._projectFolderMaps["core"] = path.dirname(coreMapFolder);

            // Wait for engine to start successfully, hopefully one second should be enough.
            // TODO: Try connection multiple time until timeout.
            setTimeout(() => this.connectToEngine(engineProcess.ip, engineProcess.port, response), 1000);
        }).catch(err => {
            return this.sendErrorResponse(response, 3001, "Failed to launch engine. "+ (err.message || err));
        });
    }

    /**
     * Attach to the engine console server using web sockets.
     */
    protected attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): void {
        var ip = args.ip;
        var port = args.port;
        var _this = this;

        // Establish web socket connection with engine.
        // Usinga timeout in order to support compound launch configurations
        setTimeout(function () { return _this.connectToEngine(ip, port, response); }, 1000);
    }

    /**
     * Client stopped the debugging session.
     * Lets close engine connection and finish session.
     */
    protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
        // Close the engine connection
        this._conn.close();
        this._conn = null;

        // Proceed with disconnection
        this.sendResponse(response);
    }

    /**
     * Called when the clients wants to reboot the engine debug session.
     * This send to the engine the `refresh` and `reboot` commands.
     */
    protected restartRequest(response: DebugProtocol.RestartResponse, args: DebugProtocol.RestartArguments): void {
        this._conn.sendCommand('reboot'/*, ['-ini settings.ini']*/);
        this.sendResponse(response);
    }

    /**
     * Client broke the debug session.
     */
    protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
        this._conn.sendDebuggerCommand('break');
        this.sendResponse(response);
    }

    /**
     * Handle client breakpoints.
     */
    protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {

        let filePath = args.source.path;
        let clientLines = args.lines;
        let validScript = true;

        // Find resource root looking for settings.ini or .stingray-asset-server-directory
        let resourcePath = filePath;
        let dirPath = path.dirname(filePath);
        while (true) {

            // Check that we have a valid script folder or that we did not reach the drive root.
            if (!dirPath || dirPath === filePath || dirPath === '.') {
                validScript = false;
                break;
            }

            let projectFilePath = _.first(helpers.findFiles(dirPath, '.stingray_project'));
            if (projectFilePath && fileExists(projectFilePath)) {
                resourcePath = path.relative(dirPath, filePath);
                this._projectFolderMaps["<project>"] = dirPath;
                break;
            }

            let stingrayDirTokenFilePath = path.join(dirPath, '.stingray-asset-server-directory');
            if (fileExists(stingrayDirTokenFilePath)) {
                let mapName = path.basename(dirPath);
                resourcePath = path.join(mapName, path.relative(dirPath, filePath));
                this._projectFolderMaps[mapName] = path.dirname(dirPath);
                break;
            }

            dirPath = path.dirname(dirPath);
        }

        // Normalize path
        let resourceName = resourcePath.replace(/\\/g, '/');

        // Verify breakpoint locations
        var breakpoints = new Array<Breakpoint>();
        for (var i = 0; i < clientLines.length; i++) {
            let l = clientLines[i];
            let breakpointId = this._breakpointId++;
            const bp = <DebugProtocol.Breakpoint> new Breakpoint(validScript, l, 0, new Source(resourceName, filePath));
            bp.id = breakpointId;
            breakpoints.push(bp);
        }

        // Store session breakpoints
        this._breakpoints.set(resourceName, validScript ? breakpoints : []);

        // Set engine breakpoints
        /**
         * @typedef {object.<string, number[]>}
         * i.e.
         * {
         *   "resource/name.lua": [24, 42, 5542] <-- lines
         * }
         */
        let engineBreakpoints = {};
        this._breakpoints.forEach((v, k) => {
            if (!_.isEmpty(v))
                engineBreakpoints[k] = v.map(bp => bp.line);
        });
        this._conn.sendDebuggerCommand('set_breakpoints', {breakpoints: engineBreakpoints});

        // Response with actual breakpoints
        response.body = { breakpoints: breakpoints };
        this.sendResponse(response);
    }

    /**
     * Returns the current engine callstack.
     */
    protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {

        if (this._initializing)
            return this.sendResponse(response);

        if (!this._callstack)
            return this.sendErrorResponse(response, 1000, "No callstack available");

        let i = 0;
        let stack = this._callstack;
        const frames = new Array<StackFrame>();
        for (let frame of stack) {
            let isMapped = frame.source[0] === '@';
            let resourcePath = isMapped ? frame.source.slice(1) : frame.source;
            // TODO: read and parse lua at line of function start.
            let name = frame.function ? `${frame.function} @ ${resourcePath}:${frame.line}` :
                                        `${resourcePath}:${frame.line}`;
            let filePath = this.getResourceFilePath(frame.source);
            if (fileExists(filePath)) {
                frames.push(new StackFrame(i++, name, new Source(frame.source, filePath), frame.line, 0));
            } else {
                frames.push(new StackFrame(i++, `${name} (Cannot find source in workspace)`));
            }
        }
        response.body = {
            stackFrames: frames,
            totalFrames: frames.length
        };
        this.sendResponse(response);
    }

    /**
     * Return the local callstack values.
     * TODO: Add global scope support
     */
    protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

        if (!this._callstack)
            return this.sendErrorResponse(response, 1000, "No callstack available");

        this._scopesContent.clear();
        this._topLevelScopes.length = 0;

        const scopes = new Array<Scope>();
        const scopeDescs = {
            local: 'Local',
            up_values: 'Closure'
        }

        _.each(scopeDescs, (scopeDisplayName, scopeId) => {
            const scopeContent = this.createScopeContent(args.frameId, scopeId);
            this.populateVariables(scopeContent, this._callstack[args.frameId][scopeId]);
            this._topLevelScopes.push(scopeContent);
            scopes.push(new Scope(scopeDisplayName, scopeContent.variablesReference, false));
        });

        response.body = { scopes: scopes };
        this.sendResponse(response);
    }

    /**
     * Resolve request client stack values.
     */
    protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments): void {
        if (!this._callstack)
            return this.sendErrorResponse(response, 1000, "No callstack available");

        const scopeContent = this._scopesContent.get(args.variablesReference);
        if (!scopeContent) {
            throw new Error('Unknown variablesReference ' + args.variablesReference);
        }

        if (scopeContent.dataReady()) {
            response.body = {
                variables: scopeContent.getVariables()
            };
            return this.sendResponse(response);
        }

        this.fetchScopeData(scopeContent).then(() => {
            response.body = {
                variables: scopeContent.getVariables()
            };
            this.sendResponse(response);
        });
    }

    /**
     * Client request to continue debugging session.
     * Tell the engine that it can now continue since we are attached.
     */
    protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
        this._conn.sendDebuggerCommand('continue');
        this.sendResponse(response);
    }

    /**
     * Step over to the next statement.
     */
    protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
        this._conn.sendDebuggerCommand('step_over');
        this.sendResponse(response);
    }

    /**
     * Step into the current call.
     */
    protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
        this._conn.sendDebuggerCommand('step_into');
        this.sendResponse(response);
    }

    /**
     * Request the engine to step out of the current function.
     */
    protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
        this._conn.sendDebuggerCommand('step_out');
        this.sendResponse(response);
    }

    /**
     * Evaluate engine commands and lua scripts
     */
    protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
        if (args.context === 'repl') {
            if (args.expression.indexOf('--') === 0) {
                let command = args.expression.slice(2).split(' ');
                this._lastEvalResponse = response;
                this._conn.sendCommand(command[0], ...command.slice(1));
            } else if (this._idStringSupport && this.isIdStringExpression(args.expression)) {
                let str = this.evaluateIdString(args.expression);
                response.body = {
                    result: str,
                    type: 'string',
                    variablesReference: 0
                };
                this.sendResponse(response);

            } else {
                this.evaluateExpression(response, args.expression);
            }
        } else if (args.context === 'hover') {
            let luaValueExpression = args.expression.replace(':', '.');
            this.evaluateExpression(response, luaValueExpression);
        } else if (args.context === 'watch') {
            this.evaluateExpression(response, args.expression);
        }
    }

    /**
     * Not used, always reporting first same thread.
     */
    protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        response.body = { threads: [ new Thread(StingrayDebugSession.THREAD_ID, "thread 1") ] };
        this.sendResponse(response);
    }

    protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
        const scopeContent = this._scopesContent.get(args.variablesReference);
        if (!scopeContent) {
            throw new Error('Unknown variablesReference ' + args.variablesReference);
        }

        let variable = scopeContent.getVariable(args.name);
        if (!variable) {
            throw new Error('Cannot find variable ' + args.name);
        }

        let newValue = helpers.stringToTypedValue(variable.type, args.value);

        this.sendDebuggerRequest('modify_variable', {
            local_num: 0,
            table_path: {
                level: scopeContent.frameId,
                local: scopeContent.isTable() ? scopeContent.tableVarName : variable.name,
                path: scopeContent.isTable() ? scopeContent.tablePath.concat(variable.tableIndex + 1) : []
            },
            value_type: variable.type,
            value: args.value
        });

        // Update local variable cahce
        variable.value = newValue;

        response.body = {
            value: args.value,
            type: variable.type
        }
        this.sendResponse(response);
    }

    protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments): void {
        // console.log('gotoTargetsRequest', args);
        this.sendResponse(response);
    }

    protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {
        // Auto completion for console typing.
        // console.log('completionsRequest debugger', args);
        this.sendResponse(response);
    }

    //---- Engine message handlers

    /**
     * Handle engine console messages.
     */
    private on_engine_message(e: EngineEvent, data: ArrayBuffer = null) {
        if (e.system) {
            let engineMessage = `[${e.level.toUpperCase()}] ${e.system} / ${e.message}\r\n`;
            this.sendEvent(new OutputEvent(engineMessage));
        } else if (e.message_type === 'command_output') {
            let result = '< ' + e.message;
            if (this._lastEvalResponse) {
                this._lastEvalResponse.body = { result: result, variablesReference: 0 };
                this.sendResponse(this._lastEvalResponse);
                this._lastEvalResponse = null;
            } else {
                this.sendEvent(new OutputEvent(result + '\r\n'));
            }
        }
    }

    /**
     * Handle engine lua debugging messages.
     */
    private on_engine_lua_debugger(e: EngineEvent, data: ArrayBuffer = null) {
        if (this._initializing) {
            // Since we now know the state of the engine, lets proceed with the client initialization.
            this.sendEvent(new InitializedEvent());

            // Tell the client that we are now attached.
            if (this._attachResponse) {
                this.sendResponse(this._attachResponse);
                this._attachResponse = null;
            }

            // Inject a few debugging functions into the running game.
            this._conn.sendScript(luaHelpers.join("\n"));
        }

        if (e.node_index || e.requestId) {
            let pendingRequest = this._requests.get(e.node_index || e.requestId);
            if (pendingRequest) {
                this._requests.delete(e.node_index);
                pendingRequest.resolve([e, data]);
            } else {
                // TODO: how to report these?
                // console.error('Message request ignored: ' + e.node_index);
            }
        } else if (e.message === 'running') {
            // ...
        } else if (e.message === 'waiting') {
            // This means that after loading breakpoints we will continue the engine evaluation.
            this._waitingForBreakpoints = true;
        } else if (e.message === 'halted') {
            let line = e.line;
            let isMapped = e.source[0] === '@';
            let resourcePath = isMapped ? e.source.slice(1) : e.source;
            if (this._breakpoints.has(resourcePath)) {
                let bp = _.first(this._breakpoints.get(resourcePath).filter(bp => bp.line === line));
                if (bp) {
                    bp.verified = true;
                    this.sendEvent(new BreakpointEvent("update", bp));
                }
            } else {
                // Unknown breakpoint, lets reset the engine state and continue.
                //this._conn.sendDebuggerCommand('set_breakpoints', {breakpoints: {}});
            }
        } else if (e.message === 'callstack') {
            this._callstack = e.stack;
            this.sendEvent(new StoppedEvent('breakpoint', StingrayDebugSession.THREAD_ID));
        }

        this._initializing = false;
    }

    //---- Events

    /**
     * Called when the engine debugger session is established.
     */
    private onEngineConnectionOpened(response: DebugProtocol.LaunchResponse) {
        // Bind additional connection messages.
        this._conn.onMessage(this.onEngineMessageReceived.bind(this));
        this._conn.onClose(this.onEngineConnectionClosed.bind(this));

        // Request engine status
        this._initializing = true;
        this._attachResponse = response;
        this._conn.sendDebuggerCommand('report_status');
    }

    /**
     * Called when an engine message is received.
     * @param {EngineMessage} dm - Engine debugging message
     * @param {ArrayBuffer} data - Message binary data
     */
    private onEngineMessageReceived(e: EngineEvent, data: ArrayBuffer = null) {
        if (e.requestId) {
            let pendingRequest = this._requests.get(e.requestId);
            if (pendingRequest) {
                this._requests.delete(e.node_index);
                pendingRequest.resolve([e, data]);
                return;
            }
        }

        let engineHandlerName = 'on_engine_' + e.type;
        if (!this[engineHandlerName])
            return;
        // Call the function type for this engine message.
        this[engineHandlerName].call(this, e, data);
    }

    /**
     * Connection with engine was closed.
     */
    private onEngineConnectionClosed() {
        this._conn = null;
        this.sendEvent(new TerminatedEvent());
    }

    /**
     * Connection with engine was aborted or the connection failed to be established.
     */
    private onEngineConnectionError(response: DebugProtocol.LaunchResponse) {
        if (response)
            this.sendErrorResponse(response, 5656, `Engine connection failure with ${this._conn._ws.url}`);
        this.sendEvent(new TerminatedEvent());
        if (this._conn)
            this._conn.close();
        this._conn = null;
    }

    //---- Implementation

    private getResourceFilePath (source) {
        let isMapped = source[0] === '@';
        let resourcePath = isMapped ? source.slice(1) : source;
        let filePath = this._projectFolderMaps["<project>"] ? path.join(this._projectFolderMaps["<project>"], resourcePath) : resourcePath;
        if (isMapped && !fileExists(filePath)) {
            let mapName = _.first(resourcePath.split('/'));
            if (mapName && this._projectFolderMaps[mapName]) {
                filePath = path.join(this._projectFolderMaps[mapName], resourcePath);
            }
        }

        return filePath;
    }

    private setupRequest() : any {
        let request = {resolve: null, reject: null};
        let requestId = this._requestId++;
        this._requests.set(requestId, request);
        let p = new Promise<any>((resolve, reject) => {
            request.resolve = resolve;
            request.reject = reject;
        });

        return {promise: p, id: requestId};
    }

    private sendDebuggerRequest (command: string, data : any, requestIdName: string = 'requestId') : Promise<any> {
        let request = this.setupRequest();

        data = data || {};
        data[requestIdName] = request.id;

        this._conn.sendDebuggerCommand(command, data);

        return request.promise;
    }

    private initIdString(projectPath : string): void {
        if (!fs.existsSync(projectPath) || fs.exists(path.join(projectPath, '.stingray_project'))) {
            throw new Error("Project path doesn't exists or is invalid");
        }

        let projectName = path.basename(projectPath);
        let projectRoot = path.dirname(projectPath);
        let projectDataPath = path.join(projectRoot, projectName + '_data');
        if (!fs.existsSync(projectDataPath)) {
            throw new Error('Cannot find project data path:' + projectDataPath);
        }

        let idStringPath = path.join(projectDataPath, 'win32', 'strings.txt');
        if (!fs.existsSync(idStringPath)) {
            throw new Error('Cannot find id string file:' + idStringPath);
        }

        try {
            let buffer = fs.readFileSync(idStringPath);
            this._idStringMap = IdString.parse(buffer);
            this._idStringSupport = true;
        } catch(err) {
            throw err;
        }
    }

    private isIdStringExpression(expression: string) : boolean {
        return expression.length > 0 && expression.indexOf('#ID[') === 0 && expression[expression.length - 1] === ']';
    }

    private evaluateIdString(expression: string) : string {
        let idString = expression.substr(4, expression.length - 5);
        let str = this._idStringMap[idString];
        return str || `<unknwown> - ${idString}`;
    }

    /**
     * Evaluate a Lua snippet and send its result in a response.
     * @param response
     * @param expression
     */
    private evaluateLuaSnippet(response: DebugProtocol.EvaluateResponse, expression: string) : Promise<any>  {
        let request = this.setupRequest();

        // Evaluate lua script on the engine side.
        let evalScript = `evaluate_script_expression([[${expression}]], ${request.id})`;
        let p = request.promise.then(result => {
            if (!result || result.length === 0)
                return;
            let msg = result[0];
            response.body = {
                result: msg.result ? msg.result.toString() : '',
                type: msg.result_type,
                variablesReference: 0
            }

            this.sendResponse(response);
        });


        this._conn.sendScript(evalScript);
        return p;
    }


    /**
     *Evaluate a Lua expression. If the expression appears to be an identifier, we dig into the scope chain to
     properly populate the response with a variablesReference.
     * @param response
     * @param expression
     */
    private evaluateExpression(response: DebugProtocol.EvaluateResponse, expression: string) {
        if (!helpers.isPotentialIdentifier(expression)) {
            return this.evaluateLuaSnippet(response, expression);
        }

        this.getIdentifierInfo(expression).then(result => {
            if (!result) {
                return this.evaluateLuaSnippet(response, expression);
            }

            if (result.identifier_type === 'table') {
                return this.evaluateIdentifier(expression).then(variable => {
                    if (!variable) {
                        // throw new Error('Cannot resolve table ' + expression);
                        response.body = {
                            result: result.identifier_value,
                            type: result.identifier_type,
                            variablesReference: 0
                        };
                        this.sendResponse(response);
                        return;
                    }

                    let scope = this._scopesContent.get(variable.variablesReference);
                    response.body = {
                        result: expression,
                        type: variable.type,
                        variablesReference: variable.variablesReference
                    };
                    this.sendResponse(response);
                });
            }

            // Immediate Value
            response.body = {
                result: result.identifier_value,
                type: result.identifier_type,
                variablesReference: 0
            };
            this.sendResponse(response);
        });
    }

    /**
     * Evaluate a luaExpression as if it was an identifier
     * @param luaValueExpression
     */
    private evaluateIdentifier(luaValueExpression: string) : Promise<any> {
        let paths = luaValueExpression.split('.');
        if (paths.length === 0) {
            // Wrongly constructed path: empty
            return Promise.resolve();
        }

        for (let topLevelScope of this._topLevelScopes) {
            let variable = topLevelScope.getVariable(paths[0]);
            if (variable) {
                if (paths.length === 1) {
                    // early out: we were accessing a first level variable
                    return Promise.resolve(variable);
                }

                // We have found the right scope containing the variable, dig into the scope further:
                return this.evaluateIdentifierInScope(topLevelScope, paths);
            }
        }

        return Promise.resolve();
    }

    /**
     * Dig from the scopes chain to find a identifier with a specific 'dot' separated path.
     * @param scope
     * @param paths
     */
    private evaluateIdentifierInScope(scope: ScopeContent, paths: Array<string>) : Promise<any> {
        return this.fetchScopeData(scope).then(() => {
            let pathToken = paths.shift();
            let variable = scope.getVariable(pathToken);
            if (!variable) {
                // Variable is not found in scope: bad path
                return Promise.resolve();
            }

            if (paths.length === 0) {
                // Variable is found
                return Promise.resolve(variable);
            }

            if (!variable.variablesReference) {
                // Variable is not a table: bad path
                return Promise.resolve();
            }

            // Dig deeper:
            let childScope = this._scopesContent.get(variable.variablesReference);
            return this.evaluateIdentifierInScope(childScope, paths);
        });
    }

    /**
     * Get an identifier from the engine
     * @param identifier
     * @param stackOffset
     */
    private getIdentifierInfo(identifier: string, stackOffset: number = 0) : Promise<any> {
        return this.sendDebuggerRequest('get_identifier_info', {
            identifier,
            stackOffset
        }).then(resultArray => {
            return resultArray.length > 0 ? resultArray[0] : null;
        });
    }

    private createScopeContent (frameId : number, scopeId : string) : ScopeContent {
        let scopeContent = new ScopeContent();
        scopeContent.variablesReference = this._variableReferenceId++;
        scopeContent.frameId = frameId;
        scopeContent.scopeId = scopeId;
        this._scopesContent.set(scopeContent.variablesReference, scopeContent);
        return scopeContent;
    }

    private populateVariables(scope: ScopeContent, stingrayTableValues: Array<any>) : void {
        const variables = [];
        for (let i = 0; i < stingrayTableValues.length; ++i) {
            let tableValue = stingrayTableValues[i];
            let varName = tableValue.var_name || tableValue.key;
            if (varName === "(*temporary)")
                continue;
            if (tableValue.value === "C function")
                continue;

            let displayName = tableValue.key;
            let value = tableValue.value;
            let type = tableValue.type;
            if (tableValue.type === 'table') {
                let tableItems = value.split('\n');
                let tableScopeContent = this.createScopeContent(scope.frameId, scope.scopeId);
                tableScopeContent.tableVarName = scope.tableVarName || varName;
                if (!scope.tablePath) {
                    tableScopeContent.tablePath = [];
                } else {
                    tableScopeContent.tablePath = scope.tablePath.concat([i + 1]);
                }

                variables.push({
                    name: varName,
                    type: type,
                    value: "{table}",
                    namedVariables: tableItems.length,
                    variablesReference: tableScopeContent.variablesReference,
                    tableIndex: i
                });
            } else {
                variables.push({
                    name: varName,
                    type: type,
                    value: value,
                    variablesReference: 0,
                    tableIndex: i
                });
            }
        }
        scope.variables = variables;
    }

    private fetchScopeData(scopeContent: ScopeContent) : Promise<any> {
        if (scopeContent.dataReady()) {
            return Promise.resolve(scopeContent);
        }

        return this.sendDebuggerRequest('expand_table', {
            local_num: 0,
            table_path: {
                level: scopeContent.frameId,
                local: scopeContent.tableVarName,
                path: scopeContent.tablePath
            }
        }, 'node_index').then(result => {
            let message = result[0];
            let tableValues = message.table !== 'nil' ? message.table : [];
            this.populateVariables(scopeContent, tableValues);
        });
    }
}

DebugSession.run(StingrayDebugSession);
