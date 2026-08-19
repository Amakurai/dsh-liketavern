/**
 * 与原生英雄区座位（workspace / 模式选择）同高的胶囊芯片。
 * 会话头部与空白页选角共用，避免一套 outline 按钮、一套 pill。
 */
import type { ReactNode } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { Avatar } from './util.js'
import './styles.js'

export function TavernSeatChip(props: {
  label: string
  title?: string
  avatarUrl?: string | null
  open?: boolean
  disabled?: boolean
  hasPopup?: 'menu' | 'dialog'
  onClick: () => void
  chevron?: boolean
  trailing?: ReactNode
}) {
  return (
    <button
      type="button"
      className="dsh-tavern-seat"
      aria-haspopup={props.hasPopup ?? 'menu'}
      aria-expanded={props.open}
      title={props.title ?? props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span className="dsh-tavern-seatIcon">
        <Avatar url={props.avatarUrl} name={props.label} size={16} />
      </span>
      <span className="dsh-tavern-seatLabel">{props.label}</span>
      {props.chevron !== false ? <IconChevronDownOutline14 className="dsh-tavern-seatChevron" /> : null}
      {props.trailing}
    </button>
  )
}
