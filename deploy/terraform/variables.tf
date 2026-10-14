variable "region" {
  description = "OCI region identifier. Always Free compute must be in the tenancy's home region (e.g. sa-saopaulo-1)."
  type        = string
}

variable "oci_config_profile" {
  description = "Profile in ~/.oci/config holding the operator's API key."
  type        = string
  default     = "DEFAULT"
}

variable "compartment_ocid" {
  description = "Compartment for every resource (the tenancy OCID uses the root compartment)."
  type        = string

  validation {
    condition     = can(regex("^ocid1\\.(compartment|tenancy)\\.", var.compartment_ocid))
    error_message = "compartment_ocid must be a compartment or tenancy OCID (ocid1.compartment... or ocid1.tenancy...)."
  }
}

variable "operator_cidr" {
  description = "IPv4 CIDR allowed to reach SSH (22), normally your own address as a /32."
  type        = string

  validation {
    condition     = can(regex("^\\d{1,3}(\\.\\d{1,3}){3}/\\d{1,2}$", var.operator_cidr)) && can(cidrhost(var.operator_cidr, 0))
    error_message = "operator_cidr must be an IPv4 CIDR such as 203.0.113.10/32."
  }

  validation {
    condition     = try(tonumber(split("/", var.operator_cidr)[1]) >= 8, false)
    error_message = "operator_cidr must not open SSH to the internet (0.0.0.0/0 or any prefix shorter than /8); use your own address, e.g. 203.0.113.10/32."
  }
}

variable "ssh_public_key" {
  description = "OpenSSH public key for the `ubuntu` user (public, not a secret). Password login is disabled."
  type        = string

  validation {
    condition     = can(regex("^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/=]+", var.ssh_public_key))
    error_message = "ssh_public_key must be an OpenSSH public key (ssh-ed25519 AAAA...)."
  }
}

variable "switchyard_version" {
  description = "Version whose deploy/compose bundle cloud-init downloads on first boot (tag v<version>). Upgrades happen on the VM (docs/deploy.md), not through this variable."
  type        = string
  default     = "0.1.0"

  validation {
    condition     = can(regex("^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.]+)?$", var.switchyard_version))
    error_message = "switchyard_version must look like 0.1.0 (without the leading v)."
  }
}

variable "name_prefix" {
  description = "Prefix for display names."
  type        = string
  default     = "switchyard"
}

variable "vcn_cidr" {
  description = "CIDR of the VCN."
  type        = string
  default     = "10.0.0.0/16"
}

variable "subnet_cidr" {
  description = "CIDR of the public subnet (inside vcn_cidr)."
  type        = string
  default     = "10.0.1.0/24"
}

variable "availability_domain_number" {
  description = "Availability domain (1-based). Try another one if Ampere A1 capacity is unavailable."
  type        = number
  default     = 1

  validation {
    condition     = var.availability_domain_number >= 1 && var.availability_domain_number <= 3
    error_message = "availability_domain_number must be 1, 2 or 3."
  }
}

# Always Free (Oracle docs, checked 2026-10-13): Ampere A1 "1,500 OCPU hours and 9,000 GB hours
# per month ... equivalent to 2 OCPUs and 12 GB of memory"; 200 GB of block storage in total,
# boot volumes included (default boot volume 50 GB). The validations keep one VM within that.
variable "ocpus" {
  description = "Ampere A1 OCPUs (Always Free: 2 in total)."
  type        = number
  default     = 2

  validation {
    condition     = var.ocpus >= 1 && var.ocpus <= 2 && floor(var.ocpus) == var.ocpus
    error_message = "ocpus must be 1 or 2 to stay within the Always Free Ampere A1 allowance."
  }
}

variable "memory_in_gbs" {
  description = "Memory in GB (Always Free: 12 in total)."
  type        = number
  default     = 12

  validation {
    condition     = var.memory_in_gbs >= 6 && var.memory_in_gbs <= 12
    error_message = "memory_in_gbs must be between 6 and 12 to run the stack within the Always Free allowance."
  }
}

variable "boot_volume_size_in_gbs" {
  description = "Boot volume size in GB (Always Free: 200 GB of block storage in total)."
  type        = number
  default     = 50

  validation {
    condition     = var.boot_volume_size_in_gbs >= 50 && var.boot_volume_size_in_gbs <= 200
    error_message = "boot_volume_size_in_gbs must be between 50 and 200 (Always Free block storage)."
  }
}

variable "image_ocid" {
  description = "Override the boot image (default: the newest Canonical Ubuntu 24.04 image for VM.Standard.A1.Flex)."
  type        = string
  default     = null
}
