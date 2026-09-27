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

output "build_command" {
  description = "Command to build and push the app image with Cloud Build."
  value = format(
    "gcloud builds submit ../app --project %s --tag %s/%s:latest",
    var.project_id, module.registry.url, var.name
  )
}

output "data_bucket" {
  description = "Bucket holding the lead/quote/onboarding store."
  value       = module.data.name
}

output "registry_url" {
  description = "Artifact Registry Docker repository URL."
  value       = module.registry.url
}

output "service_account" {
  description = "Runtime service account email."
  value       = module.service-account.email
}

output "service_uri" {
  description = "Public URL of the intake platform (set PUBLIC_BASE_URL to this)."
  value       = module.service.service_uri
}
