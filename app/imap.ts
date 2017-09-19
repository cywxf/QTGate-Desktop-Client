/*---------------------------------------------------------------------------------------------
 *  Copyright (c) QTGate System Inc. All rights reserved.
 *  Licensed under the MIT License. See License in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/// 
import * as Net from 'net'
import * as Tls from 'tls'
import * as Stream from 'stream'
import * as Event from 'events'
import * as Uuid from 'node-uuid'
import * as Async from 'async'
import * as crypto from 'crypto'
import * as Util from 'util'

const MAX_INT = 9007199254740992
const debug = true
const debugOut = ( text: string, isIn: boolean ) => {
    console.log ( `【${ new Date().toISOString()}】${ isIn ? '<=' : '=>'} 【${ text }】`)
}

interface qtGateImapwriteAppendPool {
    callback: (err?: Error) => void
    text: string
}
const idleInterval = 1000 * 60      // 3 mins
const noopInterval = 1000 * 0.5
const socketTimeOut = 1000 * 5
class ImapServerSwitchStream extends Stream.Transform {
    public commandProcess ( text: string, cmdArray: string[], next, callback ) {}
    public name: string
    private _buffer = Buffer.alloc (0)
    public serverCommandError ( err: Error, CallBack ) {
        this.imapServer.emit ( 'error', err )
        if ( CallBack )
            CallBack ( err )
    }
    public Tag: string = null
    public cmd: string = null
    public callback = false
    private doCommandCallback = null
    private _login = false
    private first = true
    private idleCallBack = null
    private waitLogout = false
    private waitLogoutCallBack = null
    private _newMailChunk = Buffer.alloc (0)
    public idleResponsrTime: NodeJS.Timer = null
    private canDoLogout = false
    private ready = false
    public appendWaitResponsrTimeOut:NodeJS.Timer = null
    private runningCommand = null
    private nextRead = true
    public idleNextStop :NodeJS.Timer = null

    constructor ( public imapServer: qtGateImap, private eachMail: boolean, private exitWithDeleteBox: boolean, private debug: boolean ) {
        super ()

        this.imapServer.on ( 'nextNewMail', () => {
            this.nextRead = true

            if (this.runningCommand!= 'idle')
                return
            if (this.imapServer.idleSupport) {
                return this.idleStop ()
            }

        })
    }

    public idleStop () {
        if ( !this.imapServer.idleSupport || this.runningCommand !== 'idle') {
            return 
        }

        clearTimeout ( this.idleNextStop )
        clearTimeout ( this.idleResponsrTime )
        this.cmd = this.runningCommand = `DONE`

        this.debug ? debugOut(this.cmd, false) : null
        if (this.writable) {
            this.idleResponsrTime = setTimeout(() => {
                console.log(`【${ new Date().toISOString() }】====================[ IDLE DONE time out ]`)
                this.imapServer.destroyAll(null)
            }, 30000 )

            return this.push(this.cmd + '\r\n')
        }
        return this.imapServer.destroyAll(null)

    }

    private doCapability ( capability ) {
        this.imapServer.serverSupportTag = capability
        this.imapServer.idleSupport = /IDLE/i.test ( capability )
        this.imapServer.condStoreSupport = /CONDSTORE/i.test ( capability )
        this.imapServer.literalPlus = /LITERAL\+/i.test ( capability )
        const ii = /X\-GM\-EXT\-1/i.test ( capability )
        const ii1 = /CONDSTORE/i.test ( capability )
        const listenFolder = this.imapServer.listenFolder
        return this.imapServer.fetchAddCom = `(${ ii ? 'X-GM-THRID X-GM-MSGID X-GM-LABELS ': '' }${ ii1 ? 'MODSEQ ' : ''}BODY[])`
    }

    private preProcessCommane ( commandLine: string, _next, callback ) {

        const cmdArray = commandLine.split (' ')
        this.debug ? debugOut ( `${ this.imapServer.listenFolder ? this.imapServer.listenFolder : '' } ${commandLine}`, true ) : null

        if ( this._login ) {
            switch ( commandLine[0] ) {

                case '+':                                    /////       +
                case '*': {                                  /////       *
                    return this.commandProcess ( commandLine, cmdArray, _next, callback )
                }

                case 'I':
                case 'D':           //  NODE
                case 'A': {                                  /////       A
                    clearTimeout ( this.appendWaitResponsrTimeOut )
                    clearTimeout ( this.idleResponsrTime )
                    if ( this.Tag !== cmdArray[0] ) {
                        return this.serverCommandError ( new Error ( `this.Tag[${ this.Tag }] !== cmdArray[0] [${ cmdArray[0] }]` ), callback )
                    }
                    if ( /^ok$/i.test ( cmdArray[1] )) {
                        if ( /^IDLE$/i.test ( cmdArray [0]) )
                            clearTimeout ( this.idleResponsrTime )
                       
                        this.doCommandCallback ()
                        return callback ()
                    }
                    
                    this.doCommandCallback ( new Error ( cmdArray.slice (2).join(' ')))
                    return callback ()

                }
                default:
                    return this.serverCommandError ( new Error (`_commandPreProcess got switch default error!` ), callback )
            }
        }
        this.login ( commandLine, cmdArray, _next, callback )
    }

    private checkFetchEnd () {

        if ( this._buffer.length <= this.imapServer.fetching ) {
            return null
        }
        
        const body = this._buffer.slice ( 0, this.imapServer.fetching )
        const uu = this._buffer.slice ( this.imapServer.fetching )
        
        let index1 = uu.indexOf ('\r\n* ')
        let index = uu.indexOf ('\r\nA') 

        index = index < 0 || index1 > 0 && index > index1 ? index1 : index

        if ( index < 0 )
            return null

        this._buffer = uu.slice ( index + 2 )
        this.imapServer.fetching = null
        return body
        
    }

    public _transform ( chunk: Buffer, encoding, next ) {
        
        this.callback = false
        //console.log ('************************************** ImapServerSwitchStream _transform chunk **************************************')
        //console.log ( chunk.toString ())
        //console.log ('************************************** ImapServerSwitchStream _transform chunk **************************************')
        this._buffer = Buffer.concat ([ this._buffer, chunk ])
        
        const doLine = () => {
            const __CallBack = () => {
                
                let index = -1
                if (!this._buffer.length || (index = this._buffer.indexOf('\r\n')) < 0) {
                    if (!this.callback) {
                        //      this is for IDLE do DONE command
                        //this.emit ( 'hold' )
                        this.callback = true
                        return next()
                    }
                    //      did next with other function
                    return
                }

                const _buf = this._buffer.slice(0, index)
                if (_buf.length) {
                    return this.preProcessCommane(_buf.toString(), next, () => {
                        this._buffer = this._buffer.slice(index + 2)
                        return doLine()
                    })
                }
                if (!this.callback) {
                    this.callback = true
                    return next()
                }
                return
            }

            if ( this.imapServer.fetching ) {
                //console.log ('************************************** ImapServerSwitchStream _transform chunk **************************************')
                //console.log ( this._buffer.toString ())
                //console.log ('************************************** ImapServerSwitchStream _transform chunk **************************************')
                const _buf1 = this.checkFetchEnd ()
                
                //  have no fill body get next chunk
                if ( ! _buf1 ) {
                    if (!this.callback) {
                        this.callback = true
                        return next()
                    }
                    return
                }
                /*
                console.log ('************************************** ImapServerSwitchStream _transform chunk **************************************')
                console.log ( _buf1.length )
                console.log ( _buf1.toString ())
                */
                this.nextRead = false
                this.imapServer.newMail(_buf1)
                
            }
            return __CallBack ()
        }

        return doLine ()
    }

    private capability () {

        this.doCommandCallback = ( err ) => {
            if ( this.imapServer.listenFolder ) {

                return this.openBox (( err, newMail ) => {
                    
                    if ( err ) {
                        console.log (`========================= [ this.openBox return err ] do this.end ()`, err )
                        return this.imapServer.destroyAll( err )
                    }
                    if ( this.waitLogout ) {
                        return this.logout_process ( this.waitLogoutCallBack )
                    }
                    if ( newMail ) {
                        return this.doNewMail ()
                    }
                    this.canDoLogout = true
                    return this.idleNoop ()
                })
            }
            this.canDoLogout = this.ready = true
            this.imapServer.emit ( 'ready' )
        }

        this.commandProcess = ( text: string, cmdArray: string[], next, callback ) => {
            switch ( cmdArray[0] ) {
                case '*': {                                  /////       *
                    //          check imap server is login ok
                    if ( /^CAPABILITY$/i.test ( cmdArray [1] ) && cmdArray.length > 2 ) {
                        const kkk = cmdArray.slice (2).join (' ')
                        this.doCapability ( kkk )
                    }
                    return callback ()
                }
                default:
                return callback ()
            }
        }

        this.Tag = `A${ this.imapServer.TagCount }`
        this.cmd = `${ this.Tag } CAPABILITY`
        this.debug ? debugOut ( this.cmd, false ) : null

        if ( this.writable )
            return this.push ( this.cmd + '\r\n')
        return this.imapServer.destroyAll( null)
    }

    private doNewMail () {
        this.canDoLogout = true
        this.checkLogout (() => {
            this.canDoLogout = false
            this.runningCommand = 'doNewMail'
            this.seachUnseen ((err, newMailIds, havemore ) => {
                if ( err ) {
                    console.log ( `doNewMail return error!`, err )
                    return this.imapServer.destroyAll( err )
                }
                if (!newMailIds || !newMailIds.length || !this.nextRead )
                    return this.idleNoop()

                let haveMoreNewMail = false
                
                return Async.waterfall ([
                    next => this.fetch(newMailIds, next),
                    ( _moreNew, next ) => {
                        haveMoreNewMail = _moreNew
                        this.flagsDeleted(newMailIds, next)
                    },
                    next => this.expunge(next)
                ], err => {
                    if ( err )
                        return this.imapServer.destroyAll ( err )
                    if (this.nextRead && (haveMoreNewMail || havemore))
                        return this.doNewMail ()
                    return this.idleNoop()
                })
                
            })
        })
        
        
    }

    private checkLogout ( CallBack ) {
        
        if ( this.waitLogout ) {
            if ( !this.canDoLogout )
                return
            if ( this.exitWithDeleteBox ) {
                return this.deleteBox (() => {
                    return this.logout_process ( this.waitLogoutCallBack )
                })
            }
            return this.logout_process ( this.waitLogoutCallBack )
        }
        CallBack ()
    }

    private idleNoop () {

        this.canDoLogout = true
        this.checkLogout (() => {
            let newSwitchRet = false
            this.runningCommand = 'idle'
            if ( ! this.ready ) {
                this.ready = true
                this.imapServer.emit ( 'ready' )
            }
            this.doCommandCallback = ( err => {
                if ( err )
                    return this.imapServer.destroyAll(null)
                this.runningCommand = null
                if ( this.idleCallBack ) {
                    this.idleCallBack ()
                    return this.idleCallBack = null
                }

                if (this.nextRead && newSwitchRet ) {
                    return this.doNewMail ()
                }
    
                if ( this.imapServer.idleSupport ) {
                    return this.idleNoop ()
                }
    
                setTimeout (() => {
                    return this.idleNoop ()
                }, noopInterval )
            })
       
            this.idleNextStop = this.imapServer.idleSupport
                ? setTimeout (() => {
                    this.idleStop ()
                }, idleInterval )
                : null
            this.commandProcess = (  text: string, cmdArray: string[], next, callback ) => {
                switch ( cmdArray[0] ) {
                    case '+':
                    case '*': {
                        clearTimeout ( this.idleResponsrTime )
                        if ( /^RECENT$|^EXISTS$/i.test ( cmdArray[2] )) {
                            if ( parseInt ( cmdArray[1])) {
                                newSwitchRet = true
                                
                                if ( !this.callback) {
                                    this.callback = true 
                                    next()
                                }
                                if (this.nextRead) {
                                    this.idleStop ()
                                }
                                
                                /*
                                if ( this.nextRead ) {
                                    clearTimeout(idleNoopTime)
                                    return this.idleStop()
                                }
                                    
                                console.log(`idle got RECENT, but this.nextRead === false [${this.nextRead}]`)
                                */
                            }
                        }
                        return callback ()
                    }
                    default:
                    return callback ()
                }
            }
            
            const name = this.imapServer.idleSupport ? 'IDLE' : 'NOOP'
            this.Tag = `${ name }`
            this.cmd = `${ name } ${ name }`

            this.debug ? debugOut ( this.cmd, false ) : null
            if ( this.writable ) {
                this.idleResponsrTime = setTimeout (() => {
                    console.log (`【${ new Date().toISOString ()}】====================[ do IDLE time out ]`)
                    this.imapServer.destroyAll(null)
                }, 30000 )
                return this.push ( this.cmd + '\r\n')
            }
            return this.imapServer.destroyAll(null)
        })
    }

    private login ( text: string, cmdArray: string[], next, _callback ) {

        this.doCommandCallback = ( err ) => {
            if ( ! err ) {
                return this.capability ()
            }
            return this.imapServer.destroyAll( err )
        }
        this.commandProcess = (  text: string, cmdArray: string[], next, callback ) => {
            switch ( cmdArray[0] ) {
                case '+':
                case '*': {
                    return callback ()
                }
                default:
                return callback ()
            }
        }
        switch ( cmdArray[0] ) {
            case '*': {                                  /////       *
                //          check imap server is login ok
                if ( /^ok$/i.test ( cmdArray [1]) && this.first ) {
                    this.first = false
                    this.Tag = `A${ this.imapServer.TagCount }`
                    this.cmd = `${ this.Tag } LOGIN "${ this.imapServer.IMapConnect.imapUserName }" "${ this.imapServer.IMapConnect.imapUserPassword }"`
                    this.debug ? debugOut ( this.cmd, false ) : null
                    this.callback = this._login = true
                    if ( this.writable )
                        return next ( null, this.cmd + '\r\n' )
                    this.imapServer.destroyAll(null)
                }
                //
                return _callback ()
            }
            default:
            return this.serverCommandError ( new Error ( `login switch default ERROR!` ), _callback )
        }

    }

    private createBox ( CallBack ) {

        this.doCommandCallback = ( err ) => {
            if ( err )
                return CallBack ( err )
            return this.openBox ( CallBack )
        }
        this.commandProcess = ( text: string, cmdArray: string[], next, callback ) => {
            return callback ()
        }
        this.Tag = `A${ this.imapServer.TagCount }`
        this.cmd = `${ this.Tag } CREATE "${ this.imapServer.listenFolder }"`
        this.debug ? debugOut ( this.cmd, false ) : null
        if ( this.writable )
            return this.push ( this.cmd + '\r\n')
        return this.imapServer.destroyAll(null)

    }

    private openBox ( CallBack ) {
        let newSwitchRet = false
        this.doCommandCallback = ( err ) => {
            if ( err ) {
                return this.createBox ( CallBack )
            }
            CallBack ( null, newSwitchRet )
        }

        this.commandProcess = ( text: string, cmdArray: string[], next, _callback ) => {
            switch ( cmdArray[0] ) {
                case '*': {
                    if ( /^EXISTS$/i.test ( cmdArray [2])) {
                        if ( parseInt ( cmdArray[1])) {
                            newSwitchRet = true
                        }
                    }
                    return _callback ()
                }
                default:
                return _callback ()
            }
        }

        const conText = this.imapServer.condStoreSupport ? ' (CONDSTORE)' : ''
        this.cmd = `SELECT "${ this.imapServer.listenFolder }"${ conText }`
        this.Tag = `A${ this.imapServer.TagCount }`
        this.cmd = `${ this.Tag } SELECT "${ this.imapServer.listenFolder }"${ conText }`
        this.debug ? debugOut ( this.cmd, false ) : null
        if ( this.writable )
            return this.push ( this.cmd + '\r\n')
        this.imapServer.destroyAll(null)
    }

    private _logout ( callabck ) {
        this.doCommandCallback = callabck
        clearTimeout ( this.idleResponsrTime )
        this.commandProcess = ( text: string, cmdArray: string[], next, _callback ) => {
            return _callback ()
        }
        
        this.Tag = `A${ this.imapServer.TagCount }`
        this.cmd = `${ this.Tag } LOGOUT`
        this.debug ? debugOut ( this.cmd, false ) : null
        if ( this.writable )
            return this.push ( this.cmd + '\r\n')
        callabck()
    }

    public append ( text: string, CallBack ) {
        if ( this.waitLogout ) {
            return this.logout_process ( this.waitLogoutCallBack )
        }
        this.canDoLogout = false
        this.doCommandCallback = () => {
            this.canDoLogout = true
            this.checkLogout ( CallBack )
        }
        let out = `Content-Type: application/octet-stream\r\nContent-Disposition: attachment\r\nMessage-ID:<${ Uuid.v4() }@>${ this.imapServer.domainName }\r\nContent-Transfer-Encoding: base64\r\nMIME-Version: 1.0\r\n\r\n${ text }`

        this.commandProcess = ( text1: string, cmdArray: string[], next, _callback ) => {
            switch ( cmdArray[0] ) {
                case '*':
                case '+': {
                    if ( ! this.imapServer.literalPlus && out.length && ! this.callback ) {
                        this.debug ? debugOut ( out, false ) : null
                        this.callback = true
                        next ( null, out + '\r\n' )
                    }
                    return _callback ()
                }
                default:
                return _callback ()
            }
        }

        this.Tag = `A${ this.imapServer.TagCount }`
        this.cmd = `APPEND "${ this.imapServer.writeFolder }" {${ out.length }${ this.imapServer.literalPlus ? '+' : ''}}`
        this.cmd = `${ this.Tag } ${ this.cmd }`
        const time = out.length / 1000 + 2000
        this.debug ? debugOut ( this.cmd, false ) : null
        if ( !this.writable )
            return this.imapServer.socket.end ()
        this.push ( this.cmd + '\r\n' )

        this.appendWaitResponsrTimeOut = setTimeout (() => {
            return this.imapServer.socket.end ()
        }, time )
        
        if ( this.imapServer.literalPlus ) {
            this.push ( out + '\r\n' )
            out = null
        }
            
    }

    private seachUnseen ( callabck ) {
        let newSwitchRet = null
        let moreNew = false
        this.doCommandCallback = ( err ) => {
            if ( err )
                return callabck ( err )
            return callabck(null, newSwitchRet, moreNew)
        }
        this.commandProcess = ( text: string, cmdArray: string[], next, _callback ) => {
            switch ( cmdArray[0] ) {
                case '*': {
                    if ( /^SEARCH$/i.test ( cmdArray [1] ) ) {
                        const uu1 = cmdArray[2] && cmdArray[2].length > 0 ? parseInt ( cmdArray[2] ) : 0
                        if ( cmdArray.length > 2 && uu1 ) {
                            if ( ! cmdArray [ cmdArray.length - 1 ].length )
                                cmdArray.pop ()
                            
                            const uu = cmdArray.slice ( 2 ).join ( ',' )
                            if ( /\,/.test ( uu [ uu.length - 1 ]) )
                                uu.substr ( 0, uu.length - 1 )
                            
                            newSwitchRet = this.eachMail ? cmdArray[2] : uu
                            moreNew = cmdArray.length > 3
                        }
                    } 
                    return _callback ()
                }
                default:
                return _callback ()
            }
        }
        this.Tag = `A${ this.imapServer.TagCount }`
        this.cmd = `${ this.Tag } UID SEARCH UNSEEN`
        this.debug ? debugOut ( this.cmd, false ) : null
        if ( this.writable )
            return this.push ( this.cmd + '\r\n')
        return this.imapServer.destroyAll ( null )
    }

    private fetch ( fetchNum, callback ) {

        this.doCommandCallback = ( err ) => {
            return callback ( err, newSwitchRet )
        }
        let newSwitchRet = false

        this.commandProcess = ( text1: string, cmdArray: string[], next, _callback ) => {
            switch ( cmdArray[0] ) {
                case '*': {
                    if ( /^FETCH$/i.test ( cmdArray [ 2 ] ) && /BODY\[\]/i.test ( cmdArray [ cmdArray.length - 2 ])) {
                        const last = cmdArray[ cmdArray.length - 1 ]
                        if ( /\{\d+\}/.test ( last )) {
                            this.imapServer.fetching = parseInt ( last.substr ( 1, last.length - 2 ))
                        }
                        return _callback ()
                    }
                    if ( /^RECENT$/i.test ( cmdArray[2]) && parseInt (cmdArray[1]) > 0 ) {
                        newSwitchRet = true
                    }
                    return _callback ()
                }
                default:
                return _callback ()
            }
        }
        this.cmd = `UID FETCH ${ fetchNum } ${ this.imapServer.fetchAddCom }`
        this.Tag = `A${ this.imapServer.TagCount }`
        this.cmd = `${ this.Tag } ${ this.cmd }`
        this.debug ? debugOut ( this.cmd, false ) : null
        if ( this.writable )
            return this.push ( this.cmd + '\r\n' )
        return this.imapServer.destroyAll ( null )
    }

    private deleteBox ( CallBack ) {
        this.doCommandCallback = CallBack
        this.commandProcess = ( text1: string, cmdArray: string[], next, _callback ) => {
            return _callback ()
        }
        this.cmd = `DELETE "${ this.imapServer.listenFolder }"`
        this.Tag = `A${ this.imapServer.TagCount }`
        this.cmd = `${ this.Tag } ${ this.cmd }`
        this.debug ? debugOut ( this.cmd, false ) : null
        if ( this.writable )
            return this.push ( this.cmd + '\r\n' )
        return this.imapServer.destroyAll ( null )
    }

    public logout ( callback ) {
        this.waitLogout = true
        this.waitLogoutCallBack = callback
        this.checkLogout ( callback )
    }

    private logout_process ( callback ) {
        if ( ! this.writable )
            return callback ()
        const doLogout = () => {
            if ( this.imapServer.listenFolder && this.imapServer.deleteBoxWhenEnd ) {
                return Async.series ([
                    next => this.deleteBox ( next ),
                    next => this._logout ( next )
                ], callback )
            }
            return this._logout ( callback )
        }
        if ( this.imapServer.listenFolder && this.imapServer.idleSupport ) {
            this.idleCallBack = doLogout
            return this.idleStop()
        }
        doLogout ()
    }

    private flagsDeleted ( num: string, callback ) {
        this.doCommandCallback = callback
        this.commandProcess = ( text1: string, cmdArray: string[], next, _callback ) => {
            return _callback ()
        }
        this.cmd = `UID STORE ${ num } FLAGS.SILENT (\\Deleted)`
        this.Tag = `A${ this.imapServer.TagCount }`
        this.cmd = `${ this.Tag } ${ this.cmd }`
        this.debug ? debugOut ( this.cmd, false ) : null
        if ( this.writable )
            return this.push ( this.cmd + '\r\n' )
        return this.imapServer.destroyAll ( null )
    }

    private expunge ( callback ) {

        let newSwitchRet = false
        this.doCommandCallback = ( err ) => {
            return callback ( err, newSwitchRet )
        }
        this.commandProcess = ( text: string, cmdArray: string[], next , _callback ) => {
            switch ( cmdArray[0] ) {
                case '*': {
                    if ( /^RECENT$/i.test ( cmdArray [2])) {
                        if ( parseInt ( cmdArray[1])) {
                            newSwitchRet = true
                        }
                    }
                    return _callback ()
                }
                default:
                return _callback ()
            }
        }
        
        this.Tag = `A${ this.imapServer.TagCount }`
        this.cmd = `${ this.Tag } EXPUNGE`
        this.debug ? debugOut ( this.cmd, false ) : null
        if ( this.writable )
            return this.push ( this.cmd + '\r\n')
        return this.imapServer.destroyAll ( null )
    }
}

export class qtGateImap extends Event.EventEmitter {
    public socket: Net.Socket
    public imapStream: ImapServerSwitchStream = new ImapServerSwitchStream ( this, this.isEachMail, this.deleteBoxWhenEnd, this.debug )
    public newSwitchRet = null
    public newSwitchError = null
    public fetching = null
    private tagcount = 0
    public domainName = this.IMapConnect.imapUserName.split ('@')[1]
    public serverSupportTag = null
    public idleSupport = null
    public condStoreSupport = null
    public literalPlus = null
    public fetchAddCom = ''
    private port = parseInt ( this.IMapConnect.imapPortNumber )
    public get TagCount () {
        if ( ++ this.tagcount < MAX_INT )
            return this.tagcount
        return this.tagcount = 0
    }
    private connectTimeOut = null

    private connect () {

        const handleEvent = () => {
            //  socket event 
                this.socket.once ( 'error', err => {
                    console.log ( `imap socket on ERROR [${ err }]` )
                    this.destroyAll ( err )
                })

            //-

            //  imapStream event

                this.imapStream.once ( 'ready', () => {
                    console.log ( `this.imapStream.once ready! [${ this.listenFolder }][${ this.writeFolder }]`)
                    this.emit ( 'ready' )
                })
            //-
        }

        const onConnect = () => {
            clearTimeout ( this.connectTimeOut )
            handleEvent ()
            this.socket.pipe ( this.imapStream ).pipe ( this.socket )
            
        }

        if ( ! this.IMapConnect.imapSsl ) {
            this.socket = Net.createConnection ({ port: this.port, host: this.IMapConnect.imapServer }, onConnect )
        } else {
            const jj = Tls.connect ({ rejectUnauthorized: ! this.IMapConnect.imapIgnoreCertificate, host: this.IMapConnect.imapServer, port: this.port }, () => {
                jj.once ( 'error', err => {
                    this.destroyAll ( err )
                })
                jj.once ( 'end', () => {
                    this.destroyAll ( null )
                })
                
                this.socket = jj
                clearTimeout ( this.connectTimeOut )
            })
            
            jj.pipe ( this.imapStream ).pipe ( jj )
        }

    
        this.connectTimeOut = setTimeout (() => {
            if ( this.socket ) {
                if ( this.socket.destroy )
                    return this.socket.destroy ()
                this.socket.end ()
            }
            this.imapStream.end ()
        }, socketTimeOut )
    }

    constructor ( public IMapConnect: imapConnect, public listenFolder: string, private isEachMail: boolean, public deleteBoxWhenEnd: boolean, public writeFolder, private debug: boolean, public newMail: ( mail ) => void ) {
        super ()
        this.connect ()
        process.once ( 'uncaughtException', err => {
            console.log ( err )
            this.destroyAll ( err )
        })
    }

    public destroyAll ( err: Error ) {
        if ( this.socket ) {
            if ( typeof this.socket.removeAllListeners === 'function') {
                this.socket.removeAllListeners ()
            }
            if ( this.socket.writable ) {
                this.socket.end ()
            }
            if ( typeof this.socket.destroy === 'function' ) {
                this.socket.destroy ()
            }
        }
        clearTimeout ( this.imapStream.idleResponsrTime )
        clearTimeout ( this.imapStream.appendWaitResponsrTimeOut )
        clearTimeout ( this.imapStream.idleNextStop )
        this.emit ( 'end', err )
    }

    public logout () {

        this.imapStream.logout (() => {
            this.destroyAll ( null )
        })
    }

}


export class qtGateImapwrite extends qtGateImap {

    private ready = false
    public canAppend = false
    private appendPool: qtGateImapwriteAppendPool[]  = []

    public append ( text: string, _callback ) {
        
        if ( ! this.ready )
            return _callback ( new Error ( 'not ready!' ))
        if ( this.canAppend ) {
            this.canAppend = false
            return this.imapStream.append ( text, err => {
                
                this.canAppend = true
                _callback ( err )
                const uu = this.appendPool.pop ()
                if ( uu ) {
                    return this.append ( uu.text, uu.callback )
                }
            })
        }
        const waitData: qtGateImapwriteAppendPool = {
            callback: _callback,
            text: text
        }
        return this.appendPool.unshift ( waitData )
    }
    
    constructor ( IMapConnect: imapConnect, writeFolder: string ) {
        super ( IMapConnect, null, false, false, writeFolder, false, null )
        this.once ( 'ready', () => {
            console.log ( `qtGateImapwrite ready`)
            this.ready = this.canAppend = true
        })
    }
}
        
export class qtGateImapRead extends qtGateImap {

    constructor ( IMapConnect: imapConnect, listenFolder: string, isEachMail: boolean, deleteBoxWhenEnd: boolean, newMail: ( mail ) => void ) {
        super ( IMapConnect, listenFolder, isEachMail, deleteBoxWhenEnd, null, false, newMail )
        this.once ( 'ready', () => {
            console.log ( `qtGateImapRead ready!`)
        })
        
    }
    
}


export const getMailAttached = (email: Buffer) => {
    const attachmentStart = email.indexOf('\r\n\r\n')
    if (attachmentStart < 0) {
        console.log(`getMailAttached error! can't faind mail attahced start!`)
        return null
    }
    const attachment = email.slice(attachmentStart + 4)
    return Buffer.from(attachment.toString(), 'base64')
}

export const imapAccountTest = ( IMapConnect: imapConnect, CallBack ) => {
    let callbackCall = false
    let startTime = null
    let wImap: qtGateImapwrite = null
    const listenFolder = Uuid.v4 ()
    const ramdomText = crypto.randomBytes ( 20 )
    const timeout = setTimeout (() => {
        if ( rImap ) {
            rImap.logout ()
        }
        if ( wImap ) {
            wImap.logout ()
        }
        doCallBack ( new Error ( 'timeout' ), null )
    }, 15000 )

    const doCallBack = ( err, ret ) => {
        if ( ! callbackCall ) {
            callbackCall = true
            clearTimeout ( timeout )
            return CallBack ( err, ret )
        }
    }
    const rImap = new qtGateImapRead ( IMapConnect, listenFolder, false, true, mail => {
        
        const attach = getMailAttached ( mail )
        if ( ! attach && ! callbackCall ) {
            return doCallBack ( new Error ( `imapAccountTest ERROR: can't read attachment!`), null)
        }
        if ( ramdomText.compare ( attach ) !== 0 && ! callbackCall ) {
            return doCallBack ( new Error ( `imapAccountTest ERROR: attachment changed!`), null )
        }
        doCallBack ( null, new Date().getTime () - startTime )

        rImap.logout ()
        
    })

    rImap.once ( 'ready', () => {
        wImap = new qtGateImapwrite ( IMapConnect, listenFolder )
        wImap.once ( 'ready', () => {
            startTime = new Date ().getTime ()
            wImap.append ( ramdomText.toString ('base64'), () => {
                wImap.logout ()
                wImap = null
            })
        })
    })

    rImap.on ( 'error', err => {
        console.log ( `rImap on ERROR `)
        doCallBack ( err, null )
    })

    rImap.once ('end', err => {
        console.log ( `rImap on END err = [${ err }]`)
        doCallBack ( err, null )
    })


}

const pingPongTimeOut = 1000 * 10

export class imapPeer extends Event.EventEmitter {
    private mailPool = []
    private keepConnectTime: NodeJS.Timer = null
    private rImapReady = false
    private waitingReplyTimeOut = null
    private lastReplyPongTime = null
    private pingUuid = null
    private doingDestroy = false
    private wImapReady = false
    private peerReady = false
    
    public newMail: ( data: any ) => void

    private mail ( email: Buffer) {

        const attr = getMailAttached (  email).toString ()
        this.deCrypto ( attr, ( err, data ) => {
            if ( err )
                return

            try {
                const uu = JSON.parse ( data )

                if ( uu.ping && uu.ping.length ) {
                    console.log ('GOT PING REPLY PONG!')
                    if ( this.wImapReady )
                        this.replyPing(uu)
                    if (!this.peerReady) {
                        console.log (`THIS peerConnect have not ready send ping!`)
                        this.pingUuid = null
                        return this.Ping()
                    }
                    
                    return
                }
                
                if ( uu.pong && uu.pong.length ) {
                    if ( !this.pingUuid && this.pingUuid !== uu.ping )
                        return console.log (`Invalid ping uuid`)
                    console.log ( `imapPeer connected`)
                    this.pingUuid = null
                    return this.emit ('ready')
                }
                return this.newMail (uu )
                
            } catch ( ex ) {
                console.log (`imapPeer mail deCrypto JSON.parse got ERROR`)
                return 
            }
        })

    }

    private commendSentError(err) {
        if ( !err ) {
            return
        }
    }

    private sendToRemote(text: Buffer, CallBack) {
        if ( this.wImap )
            return this.wImap.append(text.toString('base64'), CallBack)
    }

    private replyPing (uu) {
        
        return this.enCrypto ( JSON.stringify ({ pong: uu.ping }), ( err, data ) => {
            this.append ( data )
        })
    }
    
    public Ping () {
        if ( !this.wImapReady || this.pingUuid !== null )
            return console.log (`Ping !this.wImapReady[${!this.wImapReady}] || this.pingUuid[${ this.pingUuid }]`)
        this.pingUuid = Uuid.v4()
        return this.enCrypto ( JSON.stringify ({ ping: this.pingUuid }), ( err, data ) => {
            this.append ( data  )
            return this.commendSentError ( err )
        })
    }

    private rImap: qtGateImapRead = null

    private sendMailPool: string[] = []

    private sendAllMail() {
        if (!this.sendMailPool.length || !this.wImapReady )
            return

        const uu = Buffer.from(this.sendMailPool.pop())
        if (!uu)
            return
        this.sendToRemote(uu, err => {
            if (err) {
                console.log(`this.wImap.append error`, err)
                this.sendMailPool.push()
                setTimeout(() => {
                    return this.sendAllMail()
                }, 500)
            }
        })
    }

    private newWriteImap() {
        this.wImap = new qtGateImapwrite ( this.imapData, this.writeBox )

        this.wImap.once ( 'end', err => {
            console.log ( 'this.wImap.once end !', err )
            this.wImap = null
            if ( ! this.doingDestroy )
                return this.newWriteImap ()
        })

        this.wImap.on ('error', err => {
            if (err && err.message && /AUTH|certificate/i.test(err.message)) {
                return this.destroy(1)
            }
            console.log(`imapPeer this.wImap on error`, err)
            this.wImap.destroyAll(null)
        })

        this.wImap.once ( 'ready', () => {
            this.wImapReady = true
            console.log (`this.wImap.once on ready! send ping`)
            this.Ping ()
        })
    }

    private newReadImap() {
        this.rImap = new qtGateImapRead(this.imapData, this.listenBox, false, false, email => {
            this.mail ( email )
            this.rImap.emit(  'nextNewMail')
        })
        this.rImap.once ( 'ready', () => {
            console.log(`this.rImap.once on ready `)
            this.rImapReady = true
            if ( !this.wImap ) {
                console.log(`now make new wImap! `)
                return this.newWriteImap()
            }
        })

        this.rImap.once ( 'error', err => {
            console.log(`rImap on Error`, err)
            if (err && err.message && /AUTH|certificate/i.test(err.message)) {
                return this.destroy(1)
            }
            this.rImap.destroyAll (null)

        })
        this.rImap.once('end', err => {
            console.log ( 'this.rImap.once end !', err )
            this.rImap = null
            if ( !this.doingDestroy )
                return this.newReadImap ()
        })
    }

    private wImap: qtGateImapwrite = null

    constructor ( public imapData: imapConnect, private listenBox: string, private writeBox: string,
        private enCrypto: (text: string, callback: (err?: Error, data?: string) => void) => void,
        private deCrypto: (text: string, callback: (err?: Error, data?: string) => void) => void,
        private exit: (err?: number) => void) {
        super()
        console.log(`doing peer account [${imapData.imapUserName}] listen with[${listenBox}], write with [${writeBox}] `)
        this.newReadImap()
    }

    public destroy(err?: number) {
        if ( this.doingDestroy )
            return
        this.doingDestroy = true
        this.rImapReady = false
        this.wImapReady = false
        console.trace(`imapPeer doing destroy!`, err)
        if (this.wImap) {
            this.wImap.destroyAll(null)
            this.wImap = null
        }
        if (this.rImap) {
            this.rImap.destroyAll(null)
            this.rImap = null
        }
        if (this.exit && typeof this.exit === 'function') {
            this.exit(err)
            this.exit = null
        }
    }

    public append(text: string) {
        this.sendMailPool.unshift(text)
        return this.sendAllMail()
    }

    private sendDone() {
        return Async.waterfall([
            next => this.enCrypto(JSON.stringify({ done: new Date().toISOString() }), next),
            (data, next) => this.sendToRemote(Buffer.from(data), next)
        ], err => {
            return this.commendSentError(err)
        })
    }

}
