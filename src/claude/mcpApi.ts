// CONTRAT MCP — implémenté par le module claude (serveurs de Claude Desktop + serveurs ajoutés).
export interface McpToolInfo { server: string; name: string; description?: string; inputSchema: Record<string, unknown> }
type Impl = {
  listTools: () => Promise<McpToolInfo[]>;
  callTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<{ text: string; raw: unknown; isError?: boolean }>;
};
let impl: Impl = { listTools: async () => [], callTool: async () => { throw new Error('MCP non initialisé'); } };
export const setMcpImpl = (i: Impl) => { impl = i; };
export const listMcpTools = () => impl.listTools();
export const callMcpTool = (server: string, tool: string, args: Record<string, unknown>) => impl.callTool(server, tool, args);
