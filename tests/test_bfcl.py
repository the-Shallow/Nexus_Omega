import unittest

from nexus.verifier import bfcl


def gold_calls(case: dict) -> list[dict]:
    """A call per expected function, using the first non-omitted allowed value of each param."""
    calls = []
    for expected in case["ground_truth"]:
        (name, params), = expected.items()
        args = {k: next(v for v in allowed if v != "") for k, allowed in params.items()
                if any(v != "" for v in allowed)}
        calls.append({"name": name.replace(".", "_"), "arguments": args})
    return calls


class BfclScorerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.header, cls.cases = bfcl.load_subset()

    def test_subset_is_pinned(self):
        self.assertEqual(self.header["commit"], bfcl.COMMIT)
        self.assertEqual(len(self.cases), 4 * bfcl.PER_CATEGORY)

    def test_gold_answers_score_correct(self):
        for case in self.cases:
            calls = None if case["category"] == "irrelevance" else gold_calls(case)
            with self.subTest(case=case["id"]):
                self.assertTrue(bfcl.score_case(case, calls))

    def test_parallel_order_does_not_matter(self):
        case = next(c for c in self.cases if c["category"] == "parallel")
        self.assertTrue(bfcl.score_case(case, list(reversed(gold_calls(case)))))

    def test_wrong_or_missing_calls_fail(self):
        simple = next(c for c in self.cases if c["category"] == "simple")
        self.assertFalse(bfcl.score_case(simple, None))
        self.assertFalse(bfcl.score_case(simple, [{"name": "not_a_function", "arguments": {}}]))
        irrelevant = next(c for c in self.cases if c["category"] == "irrelevance")
        self.assertFalse(bfcl.score_case(irrelevant, [{"name": "anything", "arguments": {}}]))

    def test_tool_schema_uses_json_types_and_no_dots(self):
        tools = bfcl.tools_for([{"name": "spotify.play", "parameters": {"type": "dict", "properties": {
            "duration": {"type": "float"}}}}])
        fn = tools[0]["function"]
        self.assertEqual(fn["name"], "spotify_play")
        self.assertEqual(fn["parameters"]["type"], "object")
        self.assertEqual(fn["parameters"]["properties"]["duration"]["type"], "number")


if __name__ == "__main__":
    unittest.main()
