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

  async getServiceLogs(id: string, since = "5m"): Promise<SwarmpitLogEntry[]> {
    // Swarmpit accepts Go duration strings: "1s", "1m", "1h", "24h" etc.
    return this.request<SwarmpitLogEntry[]>("GET", `/api/services/${encodeURIComponent(id)}/logs?since=${encodeURIComponent(since)}`);
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

  async stopService(id: string): Promise<void> {
    await this.request<void>("POST", `/api/services/${encodeURIComponent(id)}/stop`);
  }

  async deleteService(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/services/${encodeURIComponent(id)}`);
  }

  async getServiceTasks(id: string): Promise<SwarmpitTask[]> {
    return this.request<SwarmpitTask[]>("GET", `/api/services/${encodeURIComponent(id)}/tasks`);
  }

  async getServiceCompose(id: string): Promise<{ compose: string }> {
    const result = await this.request<{ spec?: { compose: string }; compose?: string }>(
      "GET", `/api/services/${encodeURIComponent(id)}/compose`
    );
    return { compose: result.spec?.compose ?? result.compose ?? "" };
  }

  async getServiceNetworks(id: string): Promise<SwarmpitNetwork[]> {
    return this.request<SwarmpitNetwork[]>("GET", `/api/services/${encodeURIComponent(id)}/networks`);
  }

  // Stacks
  async listStacks(): Promise<SwarmpitStack[]> {
    return this.request<SwarmpitStack[]>("GET", "/api/stacks");
  }

  async getStackServices(name: string): Promise<SwarmpitService[]> {
    return this.request<SwarmpitService[]>("GET", `/api/stacks/${encodeURIComponent(name)}/services`);
  }

  async getStackFile(name: string): Promise<{ compose: string }> {
    const result = await this.request<{ spec?: { compose: string }; compose?: string }>(
      "GET", `/api/stacks/${encodeURIComponent(name)}/file`
    );
    // API returns { spec: { compose } } but we normalize to { compose }
    const compose = result.spec?.compose ?? result.compose ?? "";
    return { compose };
  }

  async createStack(spec: { name: string; spec: { compose: string } }): Promise<void> {
    await this.request<void>("POST", "/api/stacks", spec);
  }

  async updateStack(name: string, compose: string): Promise<void> {
    await this.request<void>("POST", `/api/stacks/${encodeURIComponent(name)}`, {
      name,
      spec: { compose },
    });
  }

  async redeployStack(name: string): Promise<void> {
    await this.request<void>("POST", `/api/stacks/${encodeURIComponent(name)}/redeploy`);
  }

  async rollbackStack(name: string): Promise<void> {
    await this.request<void>("POST", `/api/stacks/${encodeURIComponent(name)}/rollback`);
  }

  async deactivateStack(name: string): Promise<void> {
    await this.request<void>("POST", `/api/stacks/${encodeURIComponent(name)}/deactivate`);
  }

  async getStackTasks(name: string): Promise<SwarmpitTask[]> {
    return this.request<SwarmpitTask[]>("GET", `/api/stacks/${encodeURIComponent(name)}/tasks`);
  }

  async getStackVolumes(name: string): Promise<SwarmpitVolume[]> {
    return this.request<SwarmpitVolume[]>("GET", `/api/stacks/${encodeURIComponent(name)}/volumes`);
  }

  async getStackNetworks(name: string): Promise<SwarmpitNetwork[]> {
    return this.request<SwarmpitNetwork[]>("GET", `/api/stacks/${encodeURIComponent(name)}/networks`);
  }

  async getStackCompose(name: string): Promise<{ compose: string }> {
    const result = await this.request<{ spec?: { compose: string }; compose?: string }>(
      "GET", `/api/stacks/${encodeURIComponent(name)}/compose`
    );
    return { compose: result.spec?.compose ?? result.compose ?? "" };
  }

  async getStackSecrets(name: string): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>("GET", `/api/stacks/${encodeURIComponent(name)}/secrets`);
  }

  async getStackConfigs(name: string): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>("GET", `/api/stacks/${encodeURIComponent(name)}/configs`);
  }

  async createStackFile(name: string, compose: string): Promise<void> {
    await this.request<void>("POST", `/api/stacks/${encodeURIComponent(name)}/file`, { name, spec: { compose } });
  }

  async deleteStackFile(name: string): Promise<void> {
    await this.request<void>("DELETE", `/api/stacks/${encodeURIComponent(name)}/file`);
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

  async getNetworkServices(id: string): Promise<SwarmpitService[]> {
    return this.request<SwarmpitService[]>("GET", `/api/networks/${encodeURIComponent(id)}/services`);
  }

  async createNetwork(spec: Record<string, unknown>): Promise<void> {
    await this.request<void>("POST", "/api/networks", spec);
  }

  async deleteNetwork(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/networks/${encodeURIComponent(id)}`);
  }

  // Nodes
  async listNodes(): Promise<SwarmpitNode[]> {
    return this.request<SwarmpitNode[]>("GET", "/api/nodes");
  }

  async getNode(id: string): Promise<SwarmpitNode> {
    return this.request<SwarmpitNode>("GET", `/api/nodes/${encodeURIComponent(id)}`);
  }

  async editNode(id: string, spec: Record<string, unknown>): Promise<void> {
    await this.request<void>("POST", `/api/nodes/${encodeURIComponent(id)}`, spec);
  }

  async deleteNode(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/nodes/${encodeURIComponent(id)}`);
  }

  async getNodeTasks(id: string): Promise<SwarmpitTask[]> {
    return this.request<SwarmpitTask[]>("GET", `/api/nodes/${encodeURIComponent(id)}/tasks`);
  }

  // Tasks
  async listTasks(): Promise<SwarmpitTask[]> {
    return this.request<SwarmpitTask[]>("GET", "/api/tasks");
  }

  async getTask(id: string): Promise<SwarmpitTask> {
    return this.request<SwarmpitTask>("GET", `/api/tasks/${encodeURIComponent(id)}`);
  }

  // Volumes
  async listVolumes(): Promise<SwarmpitVolume[]> {
    return this.request<SwarmpitVolume[]>("GET", "/api/volumes");
  }

  async getVolume(name: string): Promise<SwarmpitVolume> {
    return this.request<SwarmpitVolume>("GET", `/api/volumes/${encodeURIComponent(name)}`);
  }

  async getVolumeServices(name: string): Promise<SwarmpitService[]> {
    return this.request<SwarmpitService[]>("GET", `/api/volumes/${encodeURIComponent(name)}/services`);
  }

  async createVolume(spec: Record<string, unknown>): Promise<void> {
    await this.request<void>("POST", "/api/volumes", spec);
  }

  async deleteVolume(name: string): Promise<void> {
    await this.request<void>("DELETE", `/api/volumes/${encodeURIComponent(name)}`);
  }

  // Secrets
  async listSecrets(): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>("GET", "/api/secrets");
  }

  async getSecret(id: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", `/api/secrets/${encodeURIComponent(id)}`);
  }

  async getSecretServices(id: string): Promise<SwarmpitService[]> {
    return this.request<SwarmpitService[]>("GET", `/api/secrets/${encodeURIComponent(id)}/services`);
  }

  async createSecret(spec: { secretName: string; data: string }): Promise<void> {
    // Swarmpit expects base64-encoded data
    const encoded = Buffer.from(spec.data, "utf-8").toString("base64");
    await this.request<void>("POST", "/api/secrets", { ...spec, data: encoded });
  }

  async deleteSecret(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/secrets/${encodeURIComponent(id)}`);
  }

  // Configs
  async listConfigs(): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>("GET", "/api/configs");
  }

  async getConfig(id: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", `/api/configs/${encodeURIComponent(id)}`);
  }

  async getConfigServices(id: string): Promise<SwarmpitService[]> {
    return this.request<SwarmpitService[]>("GET", `/api/configs/${encodeURIComponent(id)}/services`);
  }

  async createConfig(spec: { configName: string; data: string }): Promise<void> {
    // Swarmpit expects base64-encoded data
    const encoded = Buffer.from(spec.data, "utf-8").toString("base64");
    await this.request<void>("POST", "/api/configs", { ...spec, data: encoded });
  }

  async deleteConfig(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/configs/${encodeURIComponent(id)}`);
  }

  // Admin
  async listUsers(): Promise<Record<string, unknown>[]> {
    return this.request<Record<string, unknown>[]>("GET", "/api/admin/users");
  }

  async getUser(id: string): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("GET", `/api/admin/users/${encodeURIComponent(id)}`);
  }

  async createUser(spec: { username: string; password: string; role: string; email?: string }): Promise<void> {
    await this.request<void>("POST", "/api/admin/users", spec);
  }

  async editUser(id: string, spec: Record<string, unknown>): Promise<void> {
    await this.request<void>("POST", `/api/admin/users/${encodeURIComponent(id)}`, spec);
  }

  async deleteUser(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/admin/users/${encodeURIComponent(id)}`);
  }

  // Dashboard
  async pinNodeToDashboard(id: string): Promise<void> {
    await this.request<void>("POST", `/api/nodes/${encodeURIComponent(id)}/dashboard`);
  }

  async unpinNodeFromDashboard(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/nodes/${encodeURIComponent(id)}/dashboard`);
  }

  async pinServiceToDashboard(id: string): Promise<void> {
    await this.request<void>("POST", `/api/services/${encodeURIComponent(id)}/dashboard`);
  }

  async unpinServiceFromDashboard(id: string): Promise<void> {
    await this.request<void>("DELETE", `/api/services/${encodeURIComponent(id)}/dashboard`);
  }

  // Timeseries
  async getNodesTimeseries(): Promise<unknown> {
    return this.request<unknown>("GET", "/api/nodes/ts");
  }

  async getServicesCpuTimeseries(): Promise<unknown> {
    return this.request<unknown>("GET", "/api/services/ts/cpu");
  }

  async getServicesMemoryTimeseries(): Promise<unknown> {
    return this.request<unknown>("GET", "/api/services/ts/memory");
  }

  async getTaskTimeseries(name: string): Promise<unknown> {
    return this.request<unknown>("GET", `/api/tasks/${encodeURIComponent(name)}/ts`);
  }
}
