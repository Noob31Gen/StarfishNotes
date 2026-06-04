declare module 'markdown-it-mark' {
  import { PluginSimple } from 'markdown-it';
  const plugin: PluginSimple;
  export default plugin;
}

declare module 'markdown-it-sub' {
  import { PluginSimple } from 'markdown-it';
  const plugin: PluginSimple;
  export default plugin;
}

declare module 'markdown-it-sup' {
  import { PluginSimple } from 'markdown-it';
  const plugin: PluginSimple;
  export default plugin;
}

declare module 'markdown-it-task-lists' {
  import { PluginWithOptions } from 'markdown-it';
  interface TaskListsOptions {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  }
  const plugin: PluginWithOptions<TaskListsOptions>;
  export default plugin;
}

declare module 'markdown-it-texmath' {
  import { PluginWithOptions } from 'markdown-it';
  interface TexMathOptions {
    engine: unknown;
    delimiters?: string;
    katexOptions?: unknown;
  }
  const plugin: PluginWithOptions<TexMathOptions>;
  export default plugin;
}
