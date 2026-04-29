import { resize } from '../wasm/squoosh_resize';
export type ResizeModule = {
    resize: typeof resize;
};
export type ResizeOptions = {
    width?: number;
    height?: number;
    method?: 'triangular' | 'catrom' | 'mitchell' | 'lanczos3';
    premultiply?: boolean;
    linearRGB?: boolean;
};
//# sourceMappingURL=types.d.ts.map