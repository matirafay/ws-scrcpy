export function spawn(
    file: string,
    args: string[] | string,
    options: IPtyForkOptions | IWindowsPtyForkOptions,
): IPty;

export interface IPtyForkOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: { [key: string]: string | undefined };
    encoding?: string | null;
}

export interface IWindowsPtyForkOptions extends IPtyForkOptions {
    useConpty?: boolean;
    conptyInheritCursor?: boolean;
}

export interface IDisposable {
    dispose(): void;
}

export interface IEvent<T> {
    (listener: (e: T) => any): IDisposable;
}

export interface IPty {
    readonly pid: number;
    readonly cols: number;
    readonly rows: number;
    readonly process: string;
    handleFlowControl: boolean;
    readonly onData: IEvent<string>;
    readonly onExit: IEvent<{ exitCode: number; signal?: number }>;
    resize(columns: number, rows: number): void;
    write(data: string): void;
    kill(signal?: string): void;
    pause(): void;
    resume(): void;
}
