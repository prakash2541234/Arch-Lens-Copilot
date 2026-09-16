import React, { useEffect, useMemo, useState } from 'react';

function getSubscriptionName(id, subscription) {
  return subscription?.metadata?.subscriptionName
    || subscription?.metadata?.displayName
    || id;
}

export default function CentralScopeSelector({
  relData,
  selectedSubscriptionIds = [],
  value,
  onChange,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [modalStep, setModalStep] = useState('choice');
  const [resourceGroupStepSubscription, setResourceGroupStepSubscription] = useState('');
  const subscriptions = relData?.data?.subscriptions || {};
  const availableSubscriptions = useMemo(
    () => selectedSubscriptionIds
      .map((id) => ({
        id,
        data: subscriptions[id],
        name: getSubscriptionName(id, subscriptions[id]),
      }))
      .filter((item) => item.data),
    [selectedSubscriptionIds, subscriptions]
  );
  const [level, setLevel] = useState(value?.level || 'subscription');
  const [subscriptionIds, setSubscriptionIds] = useState(
    value?.subscriptionIds?.length ? value.subscriptionIds : selectedSubscriptionIds
  );
  const [resourceGroup, setResourceGroup] = useState(value?.resourceGroup || '');
  const [resourceGroups, setResourceGroups] = useState(
    value?.resourceGroups?.length ? value.resourceGroups : (value?.resourceGroup ? [value.resourceGroup] : [])
  );

  useEffect(() => {
    const validIds = availableSubscriptions.map((item) => item.id);
    setSubscriptionIds((current) => {
      const filtered = current.filter((id) => validIds.includes(id));
      const next = filtered.length || value?.enabled ? filtered : validIds;
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next;
    });
    if (!validIds.includes(resourceGroupStepSubscription)) {
      setResourceGroupStepSubscription(validIds[0] || '');
      if (resourceGroup) setResourceGroup('');
    }
  }, [availableSubscriptions, resourceGroup, resourceGroupStepSubscription, value?.enabled]);

  const availableResourceGroups = useMemo(() => {
    const subscription = subscriptions[resourceGroupStepSubscription];
    return Object.keys(subscription?.resource_groups || {});
  }, [subscriptions, resourceGroupStepSubscription]);

  const toggleResourceGroup = (name) => {
    setResourceGroups((current) => (
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name]
    ));
  };

  const toggleSubscription = (id) => {
    setSubscriptionIds((current) => (
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
    ));
  };

  const submit = () => {
    const nextSubscriptionIds = level === 'resource-group'
      ? [resourceGroupStepSubscription].filter(Boolean)
      : subscriptionIds;
    if (!nextSubscriptionIds.length) return false;
    const selectedResourceGroups = level === 'resource-group'
      ? resourceGroups
      : [];
    if (level === 'resource-group' && !selectedResourceGroups.length) return false;
    onChange({
      enabled: true,
      level,
      subscriptionIds: nextSubscriptionIds,
      resourceGroup: level === 'resource-group' ? selectedResourceGroups[0] : '',
      resourceGroups: selectedResourceGroups,
      resourceGroupSubscriptionId: level === 'resource-group' ? resourceGroupStepSubscription : '',
    });
    return true;
  };

  return (
    <div className="central-scope-control">
      <button
        type="button"
        className="arch-scope-btn central-scope-trigger"
        onClick={() => { setModalStep('choice'); setIsOpen(true); }}
      >
        {value?.enabled ? `Central Scope: ${value.level === 'resource-group' ? value.resourceGroup : `${value.subscriptionIds?.length || 0} subscription(s)`}` : 'Select Central Scope'}
      </button>

      {isOpen && (
        <div className="scope-modal-backdrop central-scope-modal-backdrop" role="dialog" aria-modal="true" aria-label="Select central scope">
          <div className="scope-modal central-scope-modal">
            {modalStep === 'choice' ? (
              <>
                <div className="scope-modal-header">
                  <h3>Select Scope Type</h3>
                  <button type="button" className="scope-modal-close" onClick={() => setIsOpen(false)} aria-label="Close">×</button>
                </div>
                <div className="central-scope-choice-list">
                  <button type="button" className="central-scope-choice" onClick={() => { setLevel('subscription'); setModalStep('selection'); }}>
                    <span>📋</span>
                    <strong>Subscription Scope</strong>
                  </button>
                  <button type="button" className="central-scope-choice" onClick={() => { setLevel('resource-group'); setResourceGroupStepSubscription(''); setModalStep('resource-group-subscription'); }}>
                    <span>📁</span>
                    <strong>Resource Group Scope</strong>
                  </button>
                </div>
                <div className="scope-modal-actions">
                  <button type="button" className="scope-type-btn" onClick={() => setIsOpen(false)}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <div className="scope-modal-header">
                  <h3>{level === 'subscription' ? 'Select Subscriptions' : 'Select Resource Group Scope'}</h3>
                  <button type="button" className="scope-modal-close" onClick={() => setIsOpen(false)} aria-label="Close">×</button>
                </div>
                {level === 'subscription' ? (
                  <div className="scope-subscription-list">
                    {availableSubscriptions.length ? (
                      <>
                        <button type="button" className="central-scope-select-all" onClick={() => setSubscriptionIds(subscriptionIds.length === availableSubscriptions.length ? [] : availableSubscriptions.map((item) => item.id))}>
                          {subscriptionIds.length === availableSubscriptions.length ? 'Clear all' : 'Select all'}
                        </button>
                        {availableSubscriptions.map((item) => (
                          <button type="button" className={`central-scope-option-button${subscriptionIds.includes(item.id) ? ' selected' : ''}`} key={item.id} onClick={() => toggleSubscription(item.id)}>
                            <span>{item.name} ({item.id})</span><span className="central-scope-selection-circle" aria-hidden="true" />
                          </button>
                        ))}
                      </>
                    ) : <div className="scope-empty-state">No subscriptions are selected in Header scope.</div>}
                  </div>
                ) : modalStep === 'resource-group-subscription' ? (
                  <div className="scope-subscription-list">
                    <h3 className="central-scope-step-title">Select Subscription</h3>
                    <button type="button" className="central-scope-select-all" onClick={() => setResourceGroupStepSubscription(availableSubscriptions.length && resourceGroupStepSubscription ? '' : (availableSubscriptions[0]?.id || ''))}>
                      {resourceGroupStepSubscription ? 'Clear selection' : 'Select first subscription'}
                    </button>
                    {availableSubscriptions.length ? availableSubscriptions.map((item) => (
                      <button type="button" className={`central-scope-option-button${resourceGroupStepSubscription === item.id ? ' selected' : ''}`} key={item.id} onClick={() => { setResourceGroupStepSubscription(item.id); setResourceGroups([]); setResourceGroup(''); setModalStep('resource-group'); }}>
                        {item.name}
                      </button>
                    )) : <div className="scope-empty-state">No subscriptions are selected in Header scope.</div>}
                  </div>
                ) : null}
                {level === 'resource-group' && modalStep === 'resource-group' && (
                  <div className="scope-form-grid">
                    <div className="central-scope-step-title">Select Resource Group</div>
                    {availableResourceGroups.length ? (
                      <>
                        <button type="button" className="central-scope-select-all" onClick={() => setResourceGroups(resourceGroups.length === availableResourceGroups.length ? [] : availableResourceGroups)}>
                          {resourceGroups.length === availableResourceGroups.length ? 'Clear all' : 'Select all'}
                        </button>
                        {availableResourceGroups.map((name) => (
                          <button type="button" className={`central-scope-option-button${resourceGroups.includes(name) ? ' selected' : ''}`} key={name} onClick={() => toggleResourceGroup(name)}>
                            <span>{name}</span><span className="central-scope-selection-circle" aria-hidden="true" />
                          </button>
                        ))}
                      </>
                    ) : <div className="scope-empty-state">No resource groups found</div>}
                  </div>
                )}
                <div className="scope-modal-actions scope-modal-actions-split">
                  <button type="button" className="scope-type-btn" onClick={() => setModalStep(level === 'resource-group' && modalStep === 'resource-group' ? 'resource-group-subscription' : 'choice')}>Back</button>
                  <button type="button" className="discover-btn central-scope-submit" onClick={() => { if (submit()) setIsOpen(false); }}>Apply Central Scope</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
