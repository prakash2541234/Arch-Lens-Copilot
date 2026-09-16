import unittest

from sec_info import (
    build_score_improvement_plan,
    calculate_strength_from_findings,
    classify_severity,
    derive_scores_from_findings,
    generate_network_security_report,
    merge_scores_with_derived,
    resolve_scores,
)


class TestSecInfo(unittest.TestCase):
    def test_classify_severity_public_exposure_critical_for_sensitive(self):
        resource = {"internetFacing": True, "containsSensitiveData": True}
        severity = classify_severity("public_exposure", resource)
        self.assertEqual(severity, "critical")

    def test_classify_severity_open_inbound_critical_for_admin_ports(self):
        resource = {"openInboundPorts": [22, 443]}
        severity = classify_severity("open_inbound", resource)
        self.assertEqual(severity, "critical")

    def test_classify_severity_monitoring_medium(self):
        resource = {}
        severity = classify_severity("monitoring", resource)
        self.assertEqual(severity, "medium")

    def test_score_improvement_plan_contains_expected_actions(self):
        subscription = {
            "id": "sub-123",
            "name": "Prod-Sub",
            "details": {
                "scoreSummary": {
                    "overall": 57,
                    "security": 41,
                    "reliability": 36,
                    "performanceEfficiency": 49,
                    "costOptimization": 63,
                    "operationalExcellence": 34,
                }
            },
        }

        scores = resolve_scores(subscription)

        plan = build_score_improvement_plan(scores)
        self.assertTrue(len(plan) > 0)

        titles = [item["title"] for item in plan]
        self.assertIn("Close public exposure, attach NSGs, and enforce private endpoints", titles)
        self.assertIn("Segment subnets and enforce ingress controls to reduce blast radius", titles)
        self.assertIn("Enable diagnostics and alerts on network resources", titles)

    def test_report_uses_scores_received_from_subscription(self):
        subscription = {
            "id": "sub-456",
            "name": "Selected-Sub",
            "scoreSummary": {
                "overall": 70,
                "security": 55,
                "reliability": 52,
                "performanceEfficiency": 58,
                "costOptimization": 72,
                "operationalExcellence": 51,
            },
        }

        resources = [
            {
                "name": "vm1",
                "type": "vm",
                "resourceGroup": "rg1",
                "nsgAttached": True,
                "publicAccess": False,
                "diagnosticsEnabled": True,
            }
        ]

        report = generate_network_security_report(subscription, resources)
        self.assertEqual(report["scoreSummary"], subscription["scoreSummary"])

    def test_resolve_scores_missing_values_use_dash(self):
        subscription = {
            "id": "sub-999",
            "name": "No-Scores-Sub",
        }

        scores = resolve_scores(subscription)
        self.assertEqual(scores["overall"], "-")
        self.assertEqual(scores["security"], "-")
        self.assertEqual(scores["reliability"], "-")
        self.assertEqual(scores["performanceEfficiency"], "-")
        self.assertEqual(scores["costOptimization"], "-")
        self.assertEqual(scores["operationalExcellence"], "-")

    def test_calculate_strength_from_findings(self):
        findings = [
            {
                "resourceName": "vm1",
                "resourceGroup": "rg1",
                "issue": "Public access enabled",
                "severity": "critical",
                "reason": "Internet exposed",
                "remediation": "Disable public access",
                "impactedPillars": ["Security"],
            },
            {
                "resourceName": "vm2",
                "resourceGroup": "rg1",
                "issue": "NSG not attached",
                "severity": "high",
                "reason": "No network filtering",
                "remediation": "Attach NSG",
                "impactedPillars": ["Security"],
            },
        ]

        strength = calculate_strength_from_findings(findings)
        self.assertIn("score", strength)
        self.assertIn("level", strength)
        self.assertIn("riskPoints", strength)
        self.assertLess(strength["score"], 100)

    def test_report_contains_strength_score(self):
        subscription = {
            "id": "sub-777",
            "name": "Risky-Sub",
        }

        resources = [
            {
                "name": "vm-public",
                "type": "vm",
                "resourceGroup": "rg-risk",
                "nsgAttached": False,
                "publicAccess": True,
                "diagnosticsEnabled": False,
            }
        ]

        report = generate_network_security_report(subscription, resources)
        self.assertIn("strengthScore", report["networkSecurity"])
        self.assertIn("score", report["networkSecurity"]["strengthScore"])

    def test_derived_scores_generated_when_input_scores_missing(self):
        subscription = {
            "id": "sub-888",
            "name": "Auto-Score-Sub",
        }

        resources = [
            {
                "name": "vm-public",
                "type": "vm",
                "resourceGroup": "rg-risk",
                "nsgAttached": False,
                "publicAccess": True,
                "diagnosticsEnabled": False,
            }
        ]

        report = generate_network_security_report(subscription, resources)
        summary = report["scoreSummary"]
        self.assertIsInstance(summary["overall"], int)
        self.assertIsInstance(summary["security"], int)
        self.assertIsInstance(summary["reliability"], int)
        self.assertIsInstance(summary["operationalExcellence"], int)

    def test_merge_scores_keeps_provided_values_and_fills_missing(self):
        findings = [
            {
                "resourceName": "r1",
                "resourceGroup": "rg1",
                "issue": "Public access enabled",
                "severity": "critical",
                "reason": "r",
                "remediation": "m",
                "impactedPillars": ["Security", "Reliability"],
            }
        ]

        resolved = {
            "overall": "-",
            "security": 80,
            "reliability": "-",
            "performanceEfficiency": "-",
            "costOptimization": "-",
            "operationalExcellence": "-",
        }

        merged = merge_scores_with_derived(resolved, findings)
        self.assertEqual(merged["security"], 80)
        self.assertIsInstance(merged["overall"], int)
        self.assertIsInstance(merged["reliability"], int)

    def test_derive_scores_from_findings_returns_all_keys(self):
        findings = [
            {
                "resourceName": "r1",
                "resourceGroup": "rg1",
                "issue": "Diagnostics disabled",
                "severity": "medium",
                "reason": "r",
                "remediation": "m",
                "impactedPillars": ["Operational Excellence", "Security", "Reliability"],
            }
        ]

        derived = derive_scores_from_findings(findings)
        self.assertIn("overall", derived)
        self.assertIn("security", derived)
        self.assertIn("reliability", derived)
        self.assertIn("performanceEfficiency", derived)
        self.assertIn("costOptimization", derived)
        self.assertIn("operationalExcellence", derived)


if __name__ == "__main__":
    unittest.main()
