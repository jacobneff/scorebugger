import { useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

const toId = (value) => (value ? String(value) : '');

const flattenEnabledCourts = (facilities) =>
  (Array.isArray(facilities) ? facilities : []).flatMap((facility) =>
    (Array.isArray(facility?.courts) ? facility.courts : [])
      .filter((court) => court?.isEnabled !== false)
      .map((court) => ({
        facilityId: toId(facility?.facilityId),
        facilityName: facility?.name || 'Facility',
        courtId: toId(court?.courtId),
        courtName: court?.name || 'Court',
      }))
  );

function DraggablePoolCard({ pool, assignedCourtLabel, disabled }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useDraggable({
    id: pool._id,
    disabled,
  });

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`court-assign-pool-card ${isDragging ? 'is-dragging' : ''}`}
      {...attributes}
      {...listeners}
    >
      <p className="court-assign-pool-title">Pool {pool.name}</p>
      <p className="court-assign-pool-meta">
        {Array.isArray(pool.teamIds) ? pool.teamIds.length : 0}
        {' / '}
        {Number.isFinite(Number(pool.requiredTeamCount)) ? Number(pool.requiredTeamCount) : 0}
        {' teams'}
      </p>
      <p className="court-assign-pool-meta">
        {assignedCourtLabel || 'No court assigned'}
      </p>
    </article>
  );
}

function CourtSlot({ court, assignedPool, disabled }) {
  const { setNodeRef, isOver } = useDroppable({
    id: court.courtId,
    disabled,
  });

  return (
    <article
      ref={setNodeRef}
      className={`court-assign-slot ${isOver ? 'is-over' : ''} ${
        assignedPool ? 'is-occupied' : ''
      }`.trim()}
    >
      <p className="court-assign-slot-title">{court.courtName}</p>
      {assignedPool ? (
        <p className="court-assign-slot-meta">Pool {assignedPool.name}</p>
      ) : (
        <p className="court-assign-slot-meta subtle">Drop a pool here</p>
      )}
    </article>
  );
}

function PoolCardPreview({ pool, assignedCourtLabel }) {
  if (!pool) {
    return null;
  }

  return (
    <article className="court-assign-pool-card court-assign-pool-card--overlay">
      <p className="court-assign-pool-title">Pool {pool.name}</p>
      <p className="court-assign-pool-meta">
        {Array.isArray(pool.teamIds) ? pool.teamIds.length : 0}
        {' / '}
        {Number.isFinite(Number(pool.requiredTeamCount)) ? Number(pool.requiredTeamCount) : 0}
        {' teams'}
      </p>
      <p className="court-assign-pool-meta">{assignedCourtLabel || 'No court assigned'}</p>
    </article>
  );
}

function CourtAssignmentsBoard({
  pools,
  facilities,
  disabled = false,
  onAssignmentsChange,
}) {
  const [activePoolId, setActivePoolId] = useState('');

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 140, tolerance: 8 },
    })
  );

  const enabledCourts = useMemo(
    () => flattenEnabledCourts(facilities),
    [facilities]
  );
  const courtById = useMemo(
    () => new Map(enabledCourts.map((court) => [court.courtId, court])),
    [enabledCourts]
  );
  const poolsByCourtId = useMemo(() => {
    const lookup = new Map();
    (Array.isArray(pools) ? pools : []).forEach((pool) => {
      const courtId = toId(pool?.assignedCourtId);
      if (courtId && !lookup.has(courtId)) {
        lookup.set(courtId, pool);
      }
    });
    return lookup;
  }, [pools]);

  const activePool = useMemo(
    () => (Array.isArray(pools) ? pools.find((pool) => pool._id === activePoolId) : null),
    [activePoolId, pools]
  );

  const getCourtLabelForPool = (pool) => {
    const courtId = toId(pool?.assignedCourtId);
    const court = courtById.get(courtId);
    return court?.courtName || pool?.homeCourt || '';
  };

  const groupedCourts = useMemo(() => {
    const grouped = new Map();
    enabledCourts.forEach((court) => {
      const key = court.facilityId || `facility-${court.facilityName}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          facilityId: court.facilityId,
          facilityName: court.facilityName,
          courts: [],
        });
      }
      grouped.get(key).courts.push(court);
    });
    return Array.from(grouped.values());
  }, [enabledCourts]);

  const handleDragStart = (event) => {
    if (disabled) {
      return;
    }
    setActivePoolId(String(event?.active?.id || ''));
  };

  const handleDragCancel = () => {
    setActivePoolId('');
  };

  const handleDragEnd = (event) => {
    const draggedPoolId = String(event?.active?.id || '');
    const targetCourtId = String(event?.over?.id || '');
    setActivePoolId('');

    if (!draggedPoolId || !targetCourtId || disabled || !courtById.has(targetCourtId)) {
      return;
    }

    const sourcePool = (Array.isArray(pools) ? pools : []).find((pool) => pool._id === draggedPoolId);
    if (!sourcePool) {
      return;
    }

    if (toId(sourcePool.assignedCourtId) === targetCourtId) {
      return;
    }

    const targetCourt = courtById.get(targetCourtId);
    const sourceCourtId = toId(sourcePool.assignedCourtId) || null;
    const sourceCourt = sourceCourtId ? courtById.get(sourceCourtId) : null;
    const occupyingPool = (Array.isArray(pools) ? pools : []).find(
      (pool) => pool._id !== sourcePool._id && toId(pool.assignedCourtId) === targetCourtId
    );

    const nextPools = (Array.isArray(pools) ? pools : []).map((pool) => {
      if (pool._id === sourcePool._id) {
        return {
          ...pool,
          assignedCourtId: targetCourt.courtId,
          assignedFacilityId: targetCourt.facilityId || null,
          homeCourt: targetCourt.courtName || pool.homeCourt || null,
        };
      }

      if (occupyingPool && pool._id === occupyingPool._id) {
        return {
          ...pool,
          assignedCourtId: sourceCourt?.courtId || null,
          assignedFacilityId: sourceCourt?.facilityId || null,
          homeCourt: sourceCourt?.courtName || null,
        };
      }

      return pool;
    });

    onAssignmentsChange?.(nextPools);
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <section className="court-assign-board">
        <div className="court-assign-column">
          <h3 className="secondary-title">Pools</h3>
          <p className="subtle">Drag a pool onto a court to assign it.</p>
          <div className="court-assign-pool-list">
            {(Array.isArray(pools) ? pools : []).map((pool) => (
              <DraggablePoolCard
                key={pool._id}
                pool={pool}
                assignedCourtLabel={getCourtLabelForPool(pool)}
                disabled={disabled}
              />
            ))}
          </div>
        </div>

        <div className="court-assign-column">
          <h3 className="secondary-title">Courts</h3>
          <p className="subtle">Each court can host one pool in this stage.</p>
          {groupedCourts.length === 0 ? (
            <p className="subtle">No enabled courts configured.</p>
          ) : (
            <div className="court-assign-slot-list">
              {groupedCourts.map((facility) => (
                <section key={facility.facilityId || facility.facilityName} className="court-assign-facility-group">
                  <h4>{facility.facilityName}</h4>
                  <div className="court-assign-slot-list">
                    {facility.courts.map((court) => (
                      <CourtSlot
                        key={court.courtId}
                        court={court}
                        assignedPool={poolsByCourtId.get(court.courtId) || null}
                        disabled={disabled}
                      />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
        <DragOverlay>
          <PoolCardPreview
            pool={activePool}
            assignedCourtLabel={activePool ? getCourtLabelForPool(activePool) : ''}
          />
        </DragOverlay>
      </section>
    </DndContext>
  );
}

export default CourtAssignmentsBoard;
