"use strict"
const path = require('path')
const deepClone = require('lodash/cloneDeep')
const electron = require("electron")
const {session} = require('electron')
const log = require("electron-log")
const {dialog, ipcMain, net} = electron

const WINDOW_OPTIONS = {
    title: "GlycReSoft",
    webPreferences: {
        preload: path.join(__dirname, "..", "static/js/preload.js"),
        nodeIntegration: true,
        contextIsolation: false,
        enableRemoteModule: true
    }
}


let SESSION_COUNTER = 1


class ProjectSession {

    constructor(project, backendServer, options){
        options = options === undefined ? {} : options

        //Guarantee unique ID
        this.instanceId = SESSION_COUNTER;
        SESSION_COUNTER++;

        this.webSessionId = "project-session-" + this.instanceId.toString()
        this.webSession = session.fromPartition(this.webSessionId, {cache: false})

        this.project = project
        this.backendServer = backendServer

        this.options = options
        this.nativeClientKey = options.nativeClientKey

        this.window = null
        this.sessionId = options.sessionId
        this.checkIfClose = true
    }

    get url(){
        return this.backendServer.url
    }

    request(options) {
        try{
            options.session = this.window.webContents.session
        } catch (err) {

        }
        return new net.request(options)
    }

    pendingTasks(callback){
        let options = {
            url: `${this.url}/api/tasks`,
        }
        log.log(`Task URL: ${options.url}`)
        let request = this.request(options)
        let buffer = []
        request.on("response", (response) => {
            response.on("end", () => {
                let result = JSON.parse(buffer.join(""))
                log.log("Collected Tasks", result)
                if(callback !== undefined) {
                    callback(result)
                }
            })
            response.on("data", (chunk) => {
                buffer.push(chunk)
            })
        })
        request.end()
    }

    endTasks(callback){
        let options = {
            url: `${this.url}/internal/end_tasks`,
            method: "post"
        }
        let request = this.request(options)
        let buffer = []
        request.on("response", (response) => {
            response.on("data", (chunk) => {
                buffer.push(chunk)
            })
            response.on("end", () => {
                if(callback !== undefined) {
                    callback(buffer.join(""))
                }
            })
        })
        request.end()
    }

    reallyQuit() {
        this.checkIfClose = false
        this.window.close()
    }

    checkTasksBeforeClose(e) {
        let self = this
        log.log((`Preparing to close Window For Project "${self.project.path}" ` +
                     `with session id ${self.sessionId} with checkIfClose value ` +
                     `${self.checkIfClose}`))
        if (self.checkIfClose) {
            e.preventDefault()

            self.pendingTasks((tasks) => {
                if (!tasks) {
                    tasks = {}
                }
                let keys = Object.keys(tasks)
                if(keys.length > 0) {
                    const messagBoxResult = dialog.showMessageBox(self.window, {
                        "title": "Close With Pending Tasks",
                        "type": "question",
                        "message": `
                    This window may close, but any pending tasks waiting to run will
                    continue running until all windows are closed and the application
                    completely shuts down.`,
                        "buttons": ["Okay", "Cancel", "Stop Tasks"],
                    }).then((response) => {
                        log.log("Choice", response)
                        if(response == 2) {
                            self.endTasks()
                        }
                        if(response == 0 || response == 2) {
                            self.reallyQuit()
                        }
                    })
                    Promise.resolve(messagBoxResult)
                } else {
                    log.log("No tasks pending. Quit right away.")
                    self.reallyQuit()
                }
            })
        }
    }

    _prepareWindowForDisplay(callback) {
        let self = this
        this.window.loadURL(this.url)
        this.window.maximize()

        ipcMain.on("openDevTools", (event) => {
            if(this.window !== null){
                this.window.webContents.openDevTools()
            }
        })

        if (callback !== undefined) {
            callback(this)
        }

        this.window.on("close", function(e) {
            self.checkTasksBeforeClose(e)
        })
    }

    createWindow(windowConfig, callback) {
        log.log("Creating window", windowConfig, callback)
        let self = this

        if (windowConfig.projectBackendId === undefined) {
            this.sessionId = 0
        } else {
            this.sessionId = windowConfig.projectBackendId
        }

        let windowOptions = deepClone(WINDOW_OPTIONS)
        windowOptions.webPreferences.session = this.webSession

        this.window = new electron.BrowserWindow(windowOptions)
        this.window.removeMenu()
        //Routes all requests this session makes to the correct
        //project's Application Manager instance on the server
        let projectSessionIdCookie = {
            "url": this.url,
            "name": "project_id",
            "value": this.sessionId.toString()
        }

        //Proves to the server that this connection is a trusted
        //native client and that it may reference the server's local
        //file system.
        let secretKeyCookie = {
            "url": this.url,
            "name": "native_client_key",
            "value": this.nativeClientKey
        }

        this.checkIfClose = true
        this.window.webContents.session.cookies.set(
            projectSessionIdCookie).then((error) => {
            if (error) {
                log.log("Error while setting cookie", error)
            }
            self.window.webContents.session.cookies.set(
                secretKeyCookie).then((error) => {
                    if (error) {
                        log.log("Error while setting cookie", error)
                    }
                    self._prepareWindowForDisplay(callback)
            })
        })

        this.window.on("closed", (e) => {
            self.backendServer.removeSession(self);
            self.window = null
        })

        this.window.webContents.on("dom-ready", function(){
            //Set up native-client particulars like SVG to PNG Export on Right-click of SVG Graphics
            self.window.webContents.executeJavaScript(`
            $('body').delegate('svg', 'contextmenu', function(e){
                const remote = require('electron').remote
                const {Menu, MenuItem} = remote
                const menu = new Menu()
                const self = this
                menu.append(new MenuItem({label: 'Save Image', click(){
                            saveSVGToFile(self)
                        }
                    })
                )
                menu.popup({window: remote.getCurrentWindow()})
            })

            $('body').delegate("img", 'contextmenu', function(e){
                const remote = require('electron').remote
                const {Menu, MenuItem} = remote
                const menu = new Menu()
                const self = this
                menu.append(new MenuItem({label: 'Save Image', click(){
                    saveIMGToPNG(self)
                        }
                    })
                )
                menu.popup({window: remote.getCurrentWindow()})
            })

            window.nativeClientKey = "${self.nativeClientKey}"

            $('body').delegate('a.external', 'click', function(e){
                e.preventDefault()
                console.log("Opening External URL", this.href)
                openExternalPage(this.href)
            })
            `)
        })
    }

    openWindow(projectWindowReadyCallback, options, waitingForSeverCallback) {
        var self = this
        let task = () => {
            self.backendServer.registerProjectSession(self.project, (registration) => {
                let windowConfig = {}
                windowConfig.projectBackendId = registration.project_id
                self.backendServer.addSession(self)
                self.createWindow(windowConfig, projectWindowReadyCallback)
            }, options)
        }

        if(this.backendServer.hasStartedProcess) {
            task()
        } else {
            this.backendServer.launchServer(() => {
                self.backendServer.waitForServer(0, () => {
                    task()
                }, waitingForSeverCallback)
            })
        }
    }
}

module.exports = ProjectSession
