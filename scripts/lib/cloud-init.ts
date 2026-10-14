/**
 * Renders deploy/terraform/cloud-init.yaml.tftpl like Terraform's templatefile() for the subset
 * the template uses (spec 013, AC-9): `${name}` placeholders and the `$${` / `%%{` escapes.
 * Template directives (`%{ ... }`) and expressions other than a plain variable are refused, so
 * the file CI validates with `cloud-init schema` is the one Terraform renders.
 */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  let out = "";
  for (let i = 0; i < template.length; i += 1) {
    const two = template.slice(i, i + 2);
    const three = template.slice(i, i + 3);
    if (three === "$${" || three === "%%{") {
      out += three.slice(1);
      i += 2;
    } else if (two === "%{") {
      throw new Error(`template directives are not supported (offset ${i})`);
    } else if (two === "${") {
      const end = template.indexOf("}", i);
      const name = template.slice(i + 2, end === -1 ? undefined : end).trim();
      if (end === -1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`unsupported template expression at offset ${i}`);
      }
      const value = vars[name];
      if (value === undefined) throw new Error(`unknown template variable "${name}"`);
      out += value;
      i = end;
    } else {
      out += template[i];
    }
  }
  return out;
}
