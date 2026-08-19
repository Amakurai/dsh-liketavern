import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';
import { Avatar } from './util.js';
import './styles.js';
export function TavernSeatChip(props) {
    return (_jsxs("button", { type: "button", className: "dsh-tavern-seat", "aria-haspopup": props.hasPopup ?? 'menu', "aria-expanded": props.open, title: props.title ?? props.label, disabled: props.disabled, onClick: props.onClick, children: [_jsx("span", { className: "dsh-tavern-seatIcon", children: _jsx(Avatar, { url: props.avatarUrl, name: props.label, size: 16 }) }), _jsx("span", { className: "dsh-tavern-seatLabel", children: props.label }), props.chevron !== false ? _jsx(IconChevronDownOutline14, { className: "dsh-tavern-seatChevron" }) : null, props.trailing] }));
}
