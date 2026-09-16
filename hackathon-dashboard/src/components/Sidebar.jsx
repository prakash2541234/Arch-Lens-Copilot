import React from 'react';
import {
  LayoutDashboard, GitBranch, ShieldAlert, Lightbulb,
  FileBarChart, MessageSquare, Settings, ClipboardList,
  Sun, Moon, BookOpen, PiggyBank
} from 'lucide-react';

const navItems = [
  { icon: LayoutDashboard, label: 'Overview', id: 'overview' },
  { icon: GitBranch, label: 'Drift Analysis', id: 'architecture' },
  { icon: ShieldAlert, label: 'Review & Risks', id: 'risks' },
  { icon: Lightbulb, label: 'Well-Architected Score', id: 'overall-scopes' },
  { icon: ClipboardList, label: 'Policy', id: 'policy' },
  { icon: PiggyBank, label: 'Cost Optimization', id: 'cost-optimization' },
  { icon: FileBarChart, label: 'Cost Analysis', id: 'reports' },
  { icon: MessageSquare, label: 'Chat Copilot', id: 'chat' },
  { icon: Settings, label: 'Settings', id: 'settings' },
];

export default function Sidebar({ activeNav, setActiveNav, isDarkMode, onToggleTheme }) {
  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <div className="logo-icon">AL</div>
        <h2>Cloud Architecture Intelligence & Drift Governance Platform</h2>
        <p>AI-Powered Azure Architecture Intelligence</p>
      </div>

      <nav className="sidebar-nav">
        {navItems.map(({ icon: Icon, label, id }) => (
          <div
            key={id}
            className={`nav-item ${activeNav === id ? 'active' : ''}`}
            onClick={() => setActiveNav(id)}
          >
            <Icon size={15} />
            <span>{label}</span>
            {activeNav === id && <span className="nav-active-dot" aria-label="Current page" />}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="theme-toggle">
          <Sun size={12} className={!isDarkMode ? 'active' : ''} />
          <button
            type="button"
            className={`toggle-switch ${isDarkMode ? 'on' : 'off'}`}
            onClick={onToggleTheme}
            aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-pressed={isDarkMode}
          />
          <Moon size={12} className={isDarkMode ? 'active' : ''} />
        </div>
        <a href="#docs">
          <BookOpen size={12} />
          <span>Documentation</span>
        </a>
      </div>
    </div>
  );
}
