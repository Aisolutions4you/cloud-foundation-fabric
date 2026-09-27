/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

# tfdoc:file:description Cloud Run deployment of the 24/7 lead intake platform.

locals {
  # secret names are not sensitive, only their values are
  secret_names = nonsensitive(toset(keys(var.secrets)))
  image = coalesce(
    var.image, "us-docker.pkg.dev/cloudrun/container/hello"
  )
}

module "registry" {
  source     = "../../../modules/artifact-registry"
  project_id = var.project_id
  location   = var.region
  name       = var.name
  format     = { docker = { standard = {} } }
}

module "service-account" {
  source       = "../../../modules/iam-service-account"
  project_id   = var.project_id
  name         = var.name
  display_name = "Lead intake platform runtime."
}

# JSON store lives on a GCS FUSE volume so leads survive restarts/revisions.
module "data" {
  source        = "../../../modules/gcs"
  project_id    = var.project_id
  prefix        = var.prefix
  name          = "${var.name}-data"
  location      = var.region
  versioning    = true
  force_destroy = !var.deletion_protection
  iam = {
    "roles/storage.objectUser" = [module.service-account.iam_email]
  }
}

module "secrets" {
  source     = "../../../modules/secret-manager"
  project_id = var.project_id
  secrets = {
    for k in local.secret_names : lower(replace(k, "_", "-")) => {
      iam = {
        "roles/secretmanager.secretAccessor" = [
          module.service-account.iam_email
        ]
      }
      versions = {
        current = {
          data        = var.secrets[k]
          data_config = { write_only_version = var.secrets_version }
        }
      }
    }
  }
}

module "service" {
  source              = "../../../modules/cloud-run-v2"
  project_id          = var.project_id
  region              = var.region
  name                = var.name
  deletion_protection = var.deletion_protection
  service_account_config = {
    create = false
    email  = module.service-account.email
  }
  containers = {
    app = {
      image = local.image
      env = merge(var.app_config, {
        DATA_DIR = "/data"
      })
      env_from_key = {
        for k in local.secret_names : k => {
          secret  = module.secrets.ids[lower(replace(k, "_", "-"))]
          version = "latest"
        }
      }
      resources = {
        limits = { cpu = "1", memory = "512Mi" }
      }
      volume_mounts = { data = "/data" }
    }
  }
  volumes = {
    data = { gcs = { bucket = module.data.name } }
  }
  service_config = {
    gen2_execution_environment = true
    # min 1: always warm, answers leads in <1s at 3am;
    # max 1: single writer for the file-based store.
    scaling = {
      min_instance_count = 1
      max_instance_count = 1
    }
  }
  iam = {
    "roles/run.invoker" = ["allUsers"]
  }
}
