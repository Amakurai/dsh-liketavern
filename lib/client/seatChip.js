import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';
import { Avatar, Skeleton } from './util.js';
import './styles.js';
export function TavernSeatChip(props) {
    return (_jsxs("button", { type: "button", className: "dsh-tavern-seat", "aria-haspopup": props.hasPopup ?? 'menu', "aria-expanded": props.open, title: props.title ?? props.label, disabled: props.disabled || props.loading, onClick: props.onClick, children: [props.loading ? (_jsxs(_Fragment, { children: [_jsx("span", { className: "dsh-tavern-seatIcon", children: _jsx(Skeleton, { width: 16, height: 16, radius: 999 }) }), _jsx("span", { className: "dsh-tavern-seatLabel", children: _jsx(Skeleton, { width: 64, height: 13 }) })] })) : (_jsxs(_Fragment, { children: [props.avatarUrl ? (_jsx("span", { className: "dsh-tavern-seatIcon", children: _jsx(Avatar, { url: props.avatarUrl, name: props.label, size: 16 }) })) : null, _jsx("span", { className: "dsh-tavern-seatLabel", children: props.label })] })), props.chevron !== false ? _jsx(IconChevronDownOutline14, { className: "dsh-tavern-seatChevron" }) : null, props.trailing] }));
}
