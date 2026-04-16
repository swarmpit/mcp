import type {
  SwarmpitService,
  SwarmpitStack,
  SwarmpitNetwork,
  SwarmpitNode,
  SwarmpitTask,
  SwarmpitVolume,
  SwarmpitLogEntry,
} from "./types.js";

export class SwarmpitApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body: string
  ) {
    super(`Swarmpit API error ${status} ${statusText}: ${body}`);
    this.name = "SwarmpitApiError";
  }
}

export class SwarmpitClient {
  private baseUrl: string;
  private token: string;
  private timeout: number;

  constructor(baseUrl: string, token: string, timeout = 30_000) {
    this.baseUrl = baseUrl;
    this.token = token;
    this.timeout = timeout;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.token.startsWith("Bearer ") ? this.token : `Bearer ${this.token}`,
      Accept: "application/json",
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        if (response.status === 401) {
          throw new SwarmpitApiError(
            401,
            response.statusText,
            "Token expired or invalid — regenerate the API token in Swarmpit"
          );
        }
        throw new SwarmpitApiError(response.status, response.statusText, text);
      }

      const text = await response.text();
      if (!text) return undefined as T;
      return JSON.parse(text) as T;
    } catch (err) {
      if (err instanceof SwarmpitApiError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Swarmpit API request timed out after ${this.timeout}ms: ${method} ${path}`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Services
  async listServices(): Promise<SwarmpitService[]> {
    return this.request<SwarmpitService[]>("GET", "/api/services");
  }

  async getService(id: string): Promise<SwarmpitService> {
    return this.request<SwarmpitService>("GET", `/api/services/${encodeURIComponent(id)}`);
  }

  async getServiceLogs(id: string, since?: string): Promise<SwarmpitLogEntry[]> {
    const query = since ? `?since=${encodeURIComponent(since)}` : "";
    return this.request<SwarmpitLogEntry[]>("GET", `/api/services/${encodeURIComponent(id)}/logs${query}`);
  }

  async createService(spec: Record<string, unknown>): Promise<{ id: string }> {
    return this.request<{ id: string }>("POST", "/api/services", spec);
  }

  async updateService(id: string, spec: Record<string, unknown>): Promise<void> {
    await this.request<void>("POST", `/api/services/${encodeURIComponent(id)}`, spec);
  }

  async redeployService(id: string, tag?: string): Promise<void> {
    const query = tag ? `?tag=${encodeURIComponent(tag)}` : "";
    await this.request<void>("POST", `/api/services/${encodeURIComponent(id)}/redeploy${query}`);
  }

  async rollbackService(id: string): Promise<void> {
    await this.request<void>("POST", `/api/services/${encodeURIComponent(id)}/rollback`);
  }

  async deleteService(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/services/${encodeURIComponent(id)}`);
  }

  async getServiceTasks(id: string): Promise<SwarmpitTask[]> {
    return this.request<SwarmpitTask[]>("GET", `/api/services/${encodeURIComponent(id)}/tasks`);
  }

  // Stacks
  async listStacks(): Promise<SwarmpitStack[]> {
    return this.request<SwarmpitStack[]>("GET", "/api/stacks");
  }

  async getStackServices(name: string): Promise<SwarmpitService[]> {
    return this.request<SwarmpitService[]>("GET", `/api/stacks/${encodeURIComponent(name)}/services`);
  }

  async getStackFile(name: string): Promise<{ compose: string }> {
    return this.request<{ compose: string }>("GET", `/api/stacks/${encodeURIComponent(name)}/file`);
  }

  async createStack(spec: { name: string; spec: { compose: string } }): Promise<void> {
    await this.request<void>("POST", "/api/stacks", spec);
  }

  async updateStack(name: string, spec: { spec: { compose: string } }): Promise<void> {
    await this.request<void>("POST", `/api/stacks/${encodeURIComponent(name)}`, spec);
  }

  async redeployStack(name: string): Promise<void> {
    await this.request<void>("POST", `/api/stacks/${encodeURIComponent(name)}/redeploy`);
  }

  async deleteStack(name: string): Promise<void> {
    await this.request<void>("DELETE", `/api/stacks/${encodeURIComponent(name)}`);
  }

  // Networks
  async listNetworks(): Promise<SwarmpitNetwork[]> {
    return this.request<SwarmpitNetwork[]>("GET", "/api/networks");
  }

  async getNetwork(id: string): Promise<SwarmpitNetwork> {
    return this.request<SwarmpitNetwork>("GET", `/api/networks/${encodeURIComponent(id)}`);
  }

  // Nodes
  async listNodes(): Promise<SwarmpitNode[]> {
    return this.request<SwarmpitNode[]>("GET", "/api/nodes");
  }

  async getNode(id: string): Promise<SwarmpitNode> {
    return this.request<SwarmpitNode>("GET", `/api/nodes/${encodeURIComponent(id)}`);
  }

  // Tasks
  async listTasks(): Promise<SwarmpitTask[]> {
    return this.request<SwarmpitTask[]>("GET", "/api/tasks");
  }

  // Volumes
  async listVolumes(): Promise<SwarmpitVolume[]> {
    return this.request<SwarmpitVolume[]>("GET", "/api/volumes");
  }

  async getVolume(name: string): Promise<SwarmpitVolume> {
    return this.request<SwarmpitVolume>("GET", `/api/volumes/${encodeURIComponent(name)}`);
  }
}
