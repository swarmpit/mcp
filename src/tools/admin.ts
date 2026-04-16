import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError } from "./helpers.js";

export function registerAdminTools(
  server: McpServer,
  client: SwarmpitClient
): void {
  server.tool(
    "list_users",
    "List all Swarmpit users (admin)",
    {},
    async () => {
      try {
        const users = await client.listUsers();
        return toolResult(users);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "get_user",
    "Get Swarmpit user details (admin)",
    { id: z.string().describe("User ID") },
    async ({ id }) => {
      try {
        const user = await client.getUser(id);
        return toolResult(user);
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "create_user",
    "Create a Swarmpit user (admin)",
    {
      username: z.string().describe("Username"),
      password: z.string().describe("Password"),
      role: z.string().describe("Role (admin or user)"),
      email: z.string().optional().describe("Email address"),
    },
    async ({ username, password, role, email }) => {
      try {
        await client.createUser({ username, password, role, email });
        return toolResult({ created: true, username });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "edit_user",
    "Edit a Swarmpit user (admin)",
    {
      id: z.string().describe("User ID"),
      spec: z.record(z.unknown()).describe("User fields to update (role, email, etc.)"),
    },
    async ({ id, spec }) => {
      try {
        await client.editUser(id, spec);
        return toolResult({ updated: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "delete_user",
    "Delete a Swarmpit user (admin). DESTRUCTIVE: requires confirm=true",
    {
      id: z.string().describe("User ID"),
      confirm: z.boolean().describe("Must be true to confirm deletion"),
    },
    async ({ id, confirm }) => {
      if (!confirm) {
        return toolError("Destructive operation: set confirm=true to delete this user");
      }
      try {
        await client.deleteUser(id);
        return toolResult({ deleted: true, id });
      } catch (e) {
        return toolError(e);
      }
    }
  );
}
