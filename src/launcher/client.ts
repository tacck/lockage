/**
 * The Lockage MCP client for lockage-publish (loosely coupled: it does not import the core and
 * drives it over stdio instead).
 *
 * lockage-publish starts the Lockage server as a **separate process** and calls MCP tools. This
 * preserves the separation that "even if publish crashes the core ledger is intact" and "the core
 * does not know about publish".
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Parse a tool result (the JSON in text content). */
function parseResult(result: unknown): any {
  const r = result as { isError?: boolean; content?: Array<{ text?: string }> };
  if (r.isError) {
    throw new Error(`lockage tool error: ${r.content?.[0]?.text ?? 'unknown'}`);
  }
  const text = r.content?.[0]?.text;
  if (text == null) throw new Error('lockage tool returned no text content');
  return JSON.parse(text);
}

export class LockageClient {
  private client: Client;
  private transport: StdioClientTransport;

  /**
   * @param args.toolsets the toolsets to enable on the server (#65). lockage-publish passes
   *   ['publisher']. If omitted, the caller environment's LOCKAGE_TOOLSETS is inherited as-is.
   */
  constructor(args: { serverEntry: string; dbPath: string; nodePath?: string; toolsets?: string[] }) {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), LOCKAGE_DB: args.dbPath };
    if (args.toolsets) env.LOCKAGE_TOOLSETS = args.toolsets.join(',');
    this.transport = new StdioClientTransport({
      command: args.nodePath ?? process.execPath,
      args: [args.serverEntry],
      env,
    });
    this.client = new Client({ name: 'lockage-launcher', version: '0.0.0' });
  }

  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => { });
  }

  private async call(name: string, args: Record<string, unknown>): Promise<any> {
    return parseResult(await this.client.callTool({ name, arguments: args }));
  }

  /**
   * The generic path to call any lockage tool. lockage-publish uses this path to call tools such as
   * read_board / read_ticket / list_tasks / acquire_publish_lock.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return this.call(name, args);
  }
}
