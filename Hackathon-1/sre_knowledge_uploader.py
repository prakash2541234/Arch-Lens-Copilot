import os
import json
import sys
import tempfile
import logging
import azure.functions as func
from azure.identity import ManagedIdentityCredential
import requests

class SREKnowledgeUploader:
    def __init__(self, audience: str):
        """
        Initialize the SRE Knowledge Uploader
        
        Args:
            audience: The audience/scope for token acquisition (e.g., https://azuresre.ai)
        """
        self.audience = audience
        self.upload_endpoint = os.getenv('SRE_UPLOAD_URL') or "https://test--191ab04d.17b1d1c8.francecentral.azuresre.ai/api/v1/agentmemory/upload"
        self.managed_identity_id = (
            os.getenv('MANAGED_IDENTITY_CLIENT_ID')
            or "280aca23-c781-4fd7-96b1-0cf0db81b925"
        )
        
        if not self.upload_endpoint:
            raise ValueError("SRE_UPLOAD_URL environment variable is not set")
        
        # Initialize managed identity credential with specific client ID
        self.credential = ManagedIdentityCredential(client_id=self.managed_identity_id)
    
    def _validate_filename(self, filename: str) -> str:
        """
        Validate filename for security and compatibility
        """
        # Check for path traversal attempts
        if '..' in filename or '/' in filename or '\\' in filename:
            raise ValueError(f"Invalid filename: path traversal detected in '{filename}'")
        
        # Check for invalid characters
        invalid_chars = ['<', '>', ':', '"', '|', '?', '*', '\0']
        if any(char in filename for char in invalid_chars):
            raise ValueError(f"Invalid filename: contains invalid characters")
        
        # Check filename length (Windows limit is 255)
        if len(filename) > 255:
            raise ValueError(f"Filename too long (max 255 characters): {len(filename)}")
        
        if len(filename) == 0:
            raise ValueError("Filename cannot be empty")
        
        return filename
    
    def parse_input(self, input_data: dict) -> dict:
        """
        Parse and validate input JSON
        
        Args:
            input_data: Dictionary containing 'data' and 'name' keys
        
        Returns:
            Validated input dictionary
        """
        if not isinstance(input_data, dict):
            raise ValueError("Input must be a JSON object")
        
        if 'data' not in input_data:
            raise ValueError("Input must contain 'data' field")
        
        if 'name' not in input_data:
            raise ValueError("Input must contain 'name' field")
        
        file_content = input_data.get('data')
        file_name = input_data.get('name')
        
        if not file_content:
            raise ValueError("'data' field cannot be empty")
        
        if not file_name:
            raise ValueError("'name' field cannot be empty")
        
        if not isinstance(file_content, str):
            raise ValueError("'data' must be a string")
        
        if not isinstance(file_name, str):
            raise ValueError("'name' must be a string")
        
        # Validate filename
        file_name = self._validate_filename(file_name)
        
        return {
            "data": file_content,
            "name": file_name
        }
    
    def create_text_file(self, file_content: str, file_name: str) -> str:
        """
        Create a text file from provided data
        
        Args:
            file_content: The content to write to the file
            file_name: Name of the file to create
        
        Returns:
            Path to created file
        """
        try:
            file_path = os.path.join(tempfile.gettempdir(), file_name)
            
            # Verify the path is safe
            if os.path.dirname(os.path.abspath(file_path)) != os.path.abspath(tempfile.gettempdir()):
                raise ValueError("Invalid file path: path escapes temporary directory")
            
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(file_content)
            
            print(f"✓ Text file created: {file_path}")
            return file_path
        
        except IOError as e:
            raise IOError(f"Failed to create file '{file_name}': {str(e)}")
        except UnicodeEncodeError as e:
            raise ValueError(f"Failed to encode file content: {str(e)}")
        except Exception as e:
            raise Exception(f"Unexpected error creating file: {str(e)}")
    
    def get_access_token(self) -> str:
        """
        Get access token using managed identity
        
        Returns:
            Access token string
        """
        try:
            token = self.credential.get_token(self.audience)
            return token.token
        except Exception as e:
            raise Exception(f"Failed to get access token: {str(e)}")
    
    def check_file_exists(self, file_name: str) -> dict:
        """
        Check if file already exists in SRE knowledge source
        
        Args:
            file_name: Name of the file to check
        
        Returns:
            Dictionary with exists status and file details if found
        """
        try:
            token = self.get_access_token()
            
            headers = {
                "Authorization": f"Bearer {token}",
                "X-Audience": self.audience
            }
            
            # Construct query endpoint safely
            if not self.upload_endpoint.endswith('/upload'):
                raise ValueError(f"Unexpected endpoint format: {self.upload_endpoint}")
            
            check_endpoint = self.upload_endpoint[:-7] + '/search'  # Remove '/upload' and add '/search'
            params = {'filename': file_name}
            
            response = requests.get(
                check_endpoint,
                headers=headers,
                params=params,
                timeout=10
            )
            
            if response.status_code == 200:
                try:
                    data = response.json()
                except ValueError as je:
                    print(f"⚠ Warning: Invalid JSON in response: {str(je)}")
                    return {"exists": False}
                
                # Safely extract file ID
                file_id = None
                if data.get('found'):
                    file_id = data.get('id')
                elif isinstance(data.get('results'), list) and len(data['results']) > 0:
                    file_id = data['results'][0].get('id') if isinstance(data['results'][0], dict) else None
                
                if file_id:
                    print(f"ℹ File '{file_name}' already exists in knowledge source")
                    return {
                        "exists": True,
                        "file_id": file_id,
                        "details": data
                    }
            
            print(f"ℹ File '{file_name}' is new (not found in knowledge source)")
            return {"exists": False}
        
        except requests.exceptions.Timeout:
            print(f"⚠ Warning: Timeout checking if file exists")
            return {"exists": False}
        except requests.exceptions.RequestException as e:
            print(f"⚠ Warning: Could not check if file exists: {str(e)}")
            return {"exists": False}
        except Exception as e:
            print(f"⚠ Warning: Error checking file existence: {str(e)}")
            return {"exists": False}
    
    def upload_to_sre_knowledge_source(self, file_path: str, file_name: str) -> dict:
        """
        Upload or update file in SRE knowledge source
        Checks if file exists and updates it, or creates new if doesn't exist
        
        Args:
            file_path: Path to the file to upload
            file_name: Name of the file in knowledge source
        
        Returns:
            Response from upload/update endpoint
        """
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")
        
        # Check if file already exists
        print(f"\n  Checking if file exists in knowledge source...")
        existence_check = self.check_file_exists(file_name)
        
        if existence_check.get('exists'):
            # File exists - perform UPDATE
            print(f"\n  → Performing UPDATE operation")
            return self._update_file_in_sre_api(file_path, file_name, existence_check.get('file_id'))
        else:
            # File doesn't exist - perform CREATE
            print(f"\n  → Performing CREATE operation")
            return self._upload_to_sre_api(file_path, file_name)
    
    def _update_file_in_sre_api(self, file_path: str, file_name: str, file_id: str) -> dict:
        """
        Update existing file in SRE Agent Memory API
        
        Args:
            file_path: Local file path
            file_name: Name of the file
            file_id: ID of existing file in knowledge source
        
        Returns:
            API response
        """
        try:
            token = self.get_access_token()
            
            headers = {
                "Authorization": f"Bearer {token}",
                "X-Audience": self.audience
            }
            
            # Construct update endpoint safely
            if not self.upload_endpoint.endswith('/upload'):
                raise ValueError(f"Unexpected endpoint format: {self.upload_endpoint}")
            
            base_endpoint = self.upload_endpoint[:-7]  # Remove '/upload'
            update_endpoint = f"{base_endpoint}/update/{file_id}"
            
            with open(file_path, 'rb') as f:
                files = {'files': (file_name, f)}
                response = requests.put(
                    update_endpoint,
                    headers=headers,
                    files=files,
                    timeout=30
                )
            
            response.raise_for_status()
            
            print(f"✓ File UPDATED in SRE Knowledge Source: {file_name}")
            print(f"  File ID: {file_id}")
            print(f"  Endpoint: {update_endpoint}")
            return {
                "status": "success",
                "operation": "update",
                "method": "sre_api",
                "filename": file_name,
                "file_id": file_id,
                "endpoint": update_endpoint,
                "response": response.json() if response.headers.get('content-type') == 'application/json' else response.text
            }
        except requests.exceptions.Timeout:
            raise Exception(f"Update request timed out for file '{file_name}'")
        except requests.exceptions.ConnectionError as e:
            raise Exception(f"Connection error updating file: {str(e)}")
        except requests.exceptions.HTTPError as e:
            response_body = e.response.text[:2000] if e.response is not None else ""
            raise Exception(
                f"SRE update rejected with HTTP {e.response.status_code if e.response is not None else 'unknown'}: "
                f"{response_body or str(e)}"
            ) from e
        except requests.exceptions.RequestException as e:
            raise Exception(f"Failed to update file via SRE API: {str(e)}")
        except IOError as e:
            raise IOError(f"Failed to read file for update: {str(e)}")
    
    def _upload_to_sre_api(self, file_path: str, filename: str) -> dict:
        """
        Create new file in SRE Agent Memory API endpoint
        
        Args:
            file_path: Local file path
            filename: Name of the file
        
        Returns:
            API response
        """
        try:
            token = self.get_access_token()
            
            headers = {
                "Authorization": f"Bearer {token}",
                "X-Audience": self.audience
            }
            
            with open(file_path, 'rb') as f:
                files = {'files': (filename, f)}
                response = requests.post(
                    self.upload_endpoint,
                    headers=headers,
                    files=files,
                    timeout=30
                )
            
            response.raise_for_status()
            
            print(f"✓ File CREATED in SRE Knowledge Source: {filename}")
            print(f"  Endpoint: {self.upload_endpoint}")
            return {
                "status": "success",
                "operation": "create",
                "method": "sre_api",
                "filename": filename,
                "endpoint": self.upload_endpoint,
                "response": response.json() if response.headers.get('content-type') == 'application/json' else response.text
            }
        except requests.exceptions.Timeout:
            raise Exception(f"Upload request timed out for file '{filename}'")
        except requests.exceptions.ConnectionError as e:
            raise Exception(f"Connection error uploading file: {str(e)}")
        except requests.exceptions.HTTPError as e:
            response_body = e.response.text[:2000] if e.response is not None else ""
            raise Exception(
                f"SRE upload rejected with HTTP {e.response.status_code if e.response is not None else 'unknown'}: "
                f"{response_body or str(e)}"
            ) from e
        except requests.exceptions.RequestException as e:
            raise Exception(f"Failed to upload via SRE API: {str(e)}")
        except IOError as e:
            raise IOError(f"Failed to read file for upload: {str(e)}")
    
    def run(self, input_json: dict, audience: str = None):
        """
        Run the complete workflow
        
        Args:
            input_json: Input JSON with 'data' and 'name' keys
            audience: Optional audience override
        """
        try:
            if audience:
                self.audience = audience
            
            # Step 1: Parse input
            print("\n[STEP 1] Parsing input...")
            parsed_input = self.parse_input(input_json)
            file_content = parsed_input['data']
            file_name = parsed_input['name']
            
            # Step 2: Create text file
            print("\n[STEP 2] Creating text file...")
            file_path = self.create_text_file(file_content, file_name)
            
            # Step 3: Upload or Update in SRE Knowledge Source
            print("\n[STEP 3] Processing file in SRE Knowledge Source...")
            try:
                upload_result = self.upload_to_sre_knowledge_source(file_path, file_name)
            finally:
                if os.path.exists(file_path):
                    os.remove(file_path)
            
            # Step 4: Summary
            print("\n[STEP 4] Operation Summary:")
            print(json.dumps(upload_result, indent=2))
            
            return {
                "success": True,
                "file_path": file_path,
                "file_name": file_name,
                "operation": upload_result.get('operation'),
                "upload_result": upload_result
            }
        
        except Exception as e:
            print(f"\n✗ Error: {str(e)}")
            return {
                "success": False,
                "error": str(e)
            }


def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        input_json = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps({"success": False, "error": "Request body must be valid JSON."}),
            status_code=400,
            mimetype="application/json",
        )

    audience = os.getenv("AUDIENCE") or "https://azuresre.ai"

    try:
        result = SREKnowledgeUploader(audience).run(input_json, audience)
        status_code = 200 if result.get("success") else 500
        return func.HttpResponse(
            json.dumps(result),
            status_code=status_code,
            mimetype="application/json",
        )
    except ValueError as exc:
        return func.HttpResponse(
            json.dumps({"success": False, "error": str(exc)}),
            status_code=400,
            mimetype="application/json",
        )
    except Exception as exc:
        logging.exception("SRE knowledge upload failed")
        return func.HttpResponse(
            json.dumps({"success": False, "error": str(exc)}),
            status_code=500,
            mimetype="application/json",
        )


def cli_main():
    """Main entry point"""
    print("""
    ╔════════════════════════════════════════════════════════════════════╗
    ║       SRE Agent Memory Upload Tool                                 ║
    ║   Endpoint: /api/v1/agentmemory/upload                             ║
    ║   Requires: SRE_UPLOAD_URL, AUDIENCE, MANAGED_IDENTITY_ID          ║
    ║   Default Managed Identity: workflowMonitor-id-87d4                ║
    ╚════════════════════════════════════════════════════════════════════╝
    """)
    
    # Get audience from environment or use default
    audience = os.getenv('AUDIENCE') or "https://azuresre.ai"
    print(f"✓ Using audience: {audience}\n")
    
    # Get input JSON from stdin or command line argument
    input_json = None
    
    if len(sys.argv) > 1:
        # Input from command line argument
        try:
            input_json = json.loads(sys.argv[1])
            print(f"✓ Input received from command line argument\n")
        except json.JSONDecodeError as e:
            print(f"✗ Invalid JSON in command line argument: {str(e)}")
            exit(1)
    else:
        # Input from stdin (pipe or paste)
        try:
            print("[INFO] Waiting for JSON input from stdin...")
            print("Expected format: {\"data\": \"...\", \"name\": \"filename.txt\"}\n")
            input_data = sys.stdin.read()
            if input_data.strip():
                input_json = json.loads(input_data)
                print(f"✓ Input received from stdin\n")
            else:
                print("✗ No input provided")
                exit(1)
        except json.JSONDecodeError as e:
            print(f"✗ Invalid JSON input: {str(e)}")
            exit(1)
    
    try:
        uploader = SREKnowledgeUploader(audience)
        result = uploader.run(input_json, audience)
        
        if result["success"]:
            print("\n✓ Process completed successfully!")
        else:
            print(f"\n✗ Process failed: {result['error']}")
            exit(1)
    except Exception as e:
        print(f"\n✗ Error initializing uploader: {str(e)}")
        exit(1)


if __name__ == "__main__":
    cli_main()