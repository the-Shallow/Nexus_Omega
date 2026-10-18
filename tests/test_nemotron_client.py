"""Wire-format checks for model calls with and without tools."""

import io
import json
import unittest
from unittest.mock import patch

from nexus.infrastructure.nemotron import VLLMClientConfig, VLLMNemotronClient


class NemotronClientTests(unittest.TestCase):
    def test_text_only_call_omits_tool_choice(self):
        captured = []

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *arguments):
                self.close()

        def fake_urlopen(request, timeout):
            captured.append(json.loads(request.data))
            return Response(json.dumps({
                "choices": [{"message": {"content": '{"edits": []}', "tool_calls": []}}]
            }).encode("utf-8"))

        client = VLLMNemotronClient(
            VLLMClientConfig(base_url="http://localhost:8000/v1", model="fixture")
        )
        with patch("nexus.infrastructure.nemotron.urllib.request.urlopen", fake_urlopen):
            turn = client.complete([{"role": "user", "content": "Suggest an edit"}], [])
        self.assertEqual(turn.content, '{"edits": []}')
        self.assertNotIn("tools", captured[0])
        self.assertNotIn("tool_choice", captured[0])


if __name__ == "__main__":
    unittest.main()
