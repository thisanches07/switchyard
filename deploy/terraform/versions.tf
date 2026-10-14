# Pinned toolchain (spec 013, AC-7). The provider hashes for Linux, macOS and Windows live in
# .terraform.lock.hcl; regenerate it with `terraform providers lock` (see docs/deploy.md).
terraform {
  required_version = ">= 1.16.5, < 1.17.0"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "= 9.8.0"
    }
  }
}

# Credentials come from the operator's ~/.oci/config (API key), never from variables, so no
# secret ends up in variables or state.
provider "oci" {
  region              = var.region
  config_file_profile = var.oci_config_profile
}
