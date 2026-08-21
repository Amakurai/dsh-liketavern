/**
 * 浏览器端最小类型垫片。
 * react / react/jsx-runtime / @deepseek-ai/dsh-client-ui-primitives 均由宿主
 * 在运行时提供（esbuild external），本仓库刻意不安装 @types/react（零新依赖），
 * 这里只给出够通过 strict 检查的宽松声明。
 */

declare module 'react' {
  export type ReactNode = any
  export interface CSSProperties {
    [property: string]: string | number | null | undefined
  }
  export function useState<T>(initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useLayoutEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
  export function useMemo<T>(factory: () => T, deps: readonly unknown[]): T
  export function useCallback<T>(fn: T, deps: readonly unknown[]): T
  export function useRef<T>(initial: T): { current: T }
  export const Fragment: any
  const defaultExport: any
  export default defaultExport
}

declare module 'react/jsx-runtime' {
  /** 原生元素 props：事件处理器给出最小上下文类型，其余宽松。 */
  interface DomElementProps {
    onChange?: (e: { target: any }) => void
    onClick?: (e: any) => void
    onBlur?: (e: any) => void
    onFocus?: (e: any) => void
    [name: string]: any
  }
  export namespace JSX {
    type Element = any
    interface ElementChildrenAttribute {
      children: unknown
    }
    interface IntrinsicAttributes {
      key?: string | number | null
    }
    interface IntrinsicElements {
      [name: string]: DomElementProps
    }
  }
  export const Fragment: any
  export function jsx(type: any, props: any, key?: any): any
  export function jsxs(type: any, props: any, key?: any): any
}

declare module 'react-dom' {
  export function createPortal(children: any, container: Element | DocumentFragment, key?: string | null): any
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  /** 宿主原语，类型见 profiles 内包类型文件；此处宽松为 any。 */
  export const Modal: any
  export const Toast: any
  export const Button: any
  export const Menu: any
  export const Input: any
  export const Pill: any
  export const Tooltip: any
  export const IconBranchOutline16: any
  export const IconEditOutline16: any
  export const IconListPenOutline16: any
  export const IconRefreshOutline16: any
  export const IconLoadingOutline16: any
  export const IconTrashOutline16: any
  export const IconPlusOutline16: any
  export const IconSearchOutline16: any
  export const IconUserOutline16: any
  export const IconChevronDownOutline14: any
  export const IconChevronLeftOutline14: any
  export const IconChevronRightOutline14: any
  export const IconFolderOpenOutline16: any
  export const IconCopyOutline16: any
  export const IconDownloadOutline16: any
  export const IconPlayOutline16: any
  export const MarkdownText: any
  export const JsonBlock: any
}
