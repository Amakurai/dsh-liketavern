/** 可信宿主卡面持有的运行时租约；frameId 与服务端 token 不传给 iframe，业务请求只携带枚举身份。 */
import type {SessionBinding} from './binding.js'

export interface HelperFrameLease {frameId:string;runtimeId:string;epoch:number;token:string}
export interface HelperFrameOpen {sessionId:string;messageId:number;storyId:string;frameId:string;runtimeId:string;epoch:number;readOnly:boolean}
export interface HelperFrameClose extends Omit<HelperFrameOpen,'storyId'|'readOnly'> {token?:string}
export type HelperFrameWriteGuard = (binding:SessionBinding)=>void
