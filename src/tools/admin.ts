import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RedactMode } from "../config.js";
import { SwarmpitClient } from "../client.js";
import { toolResult, toolError, resolveData } from "./helpers.js";

/**
 * User records carry no live credential (the server strips :password), but
 * api-token metadata and CouchDB revisions are reconnaissance the strict
 * modes exist to withhold. Fail closed on any field we didn't opt in to.
 */
export function redactUser(
  user: Record<string, unknown>,
  redact: RedactMode
): Record<string, unknown> {
  if (redact === "none") return user;
  const { _id, username, role, email } = user;
  const result: Record<string, unknown> = { _id, username, role };
  if (email !== undefined) result.email = email;
  if (user["api-token"]) result.hasApiToken = true;
  return result;
}

const passwordInput = z.union([
  z.string(),
  z.object({ $env: z.string() }).describe("Reference to local env var"),
  z.object({ $file: z.string() }).describe("Read from local file path"),
]);

const passwordDescription =
  "Password — prefer { $env: VAR_NAME } or { $file: /path }; a literal string is recorded verbatim in the model context and the tool-call transcript";

export function registerAdminTools(
  server: McpServer,
  client: SwarmpitClient,
  redact: RedactMode
): void {
  server.tool(
    "list_users",
    "List all Swarmpit users (admin)",
    {},
    async () => {
      try {
        const users = await client.listUsers();
        return toolResult(users.map((u) => redactUser(u, redact)));
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
        return toolResult(redactUser(user, redact));
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "create_user",
    "Create a Swarmpit user (admin). Pass the password as { $env: VAR_NAME } or { $file: /path } to keep it out of the conversation.",
    {
      username: z.string().describe("Username"),
      password: passwordInput.describe(passwordDescription),
      role: z.string().describe("Role (admin or user)"),
      email: z.string().optional().describe("Email address"),
    },
    async ({ username, password, role, email }) => {
      try {
        await client.createUser({ username, password: resolveData(password), role, email });
        return toolResult({ created: true, username });
      } catch (e) {
        return toolError(e);
      }
    }
  );

  server.tool(
    "edit_user",
    "Edit a Swarmpit user (admin). A password in spec may be { $env: VAR_NAME } or { $file: /path }.",
    {
      id: z.string().describe("User ID"),
      spec: z.record(z.unknown()).describe("User fields to update (role, email, etc.)"),
    },
    async ({ id, spec }) => {
      try {
        const payload =
          spec.password === undefined
            ? spec
            : { ...spec, password: resolveData(spec.password) };
        await client.editUser(id, payload);
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
