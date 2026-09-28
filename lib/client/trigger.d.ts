interface TriggerNode {
    data: {
        content?: readonly {
            type: string;
            text?: string;
        }[];
        source?: {
            kind?: string;
        };
    };
}
export declare function TavernTurnTrigger(props: {
    node: TriggerNode;
}): import("react").JSX.Element;
export {};
