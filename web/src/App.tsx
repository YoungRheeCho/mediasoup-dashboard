import { Navigate, Route, Routes } from 'react-router-dom';

import { Layout, MetaContext } from './components/Layout';
import { PageSkeleton } from './components/Panel';
import type { MetaResponse } from './lib/api';
import { usePolling } from './lib/usePolling';
import { EdgeAlerts } from './pages/Alerts';
import { EdgeBroadcasts } from './pages/edge/Broadcasts';
import { EdgeOverview } from './pages/edge/Overview';
import { EdgePipe } from './pages/edge/Pipe';
import { EdgeViewerDetail } from './pages/edge/ViewerDetail';
import { EdgeViewers } from './pages/edge/Viewers';
import { EdgeWorkers } from './pages/edge/Workers';
import { OriginBroadcaster } from './pages/origin/Broadcaster';
import { OriginEdges } from './pages/origin/Edges';
import { OriginOverview } from './pages/origin/Overview';
import { OriginRooms } from './pages/origin/Rooms';

/** 이 사이드카가 edge인지 origin인지에 따라 화면 묶음을 고른다. */
export function App() {
	const meta = usePolling<MetaResponse>('/api/meta', 60_000);

	if (!meta.data) {
		return (
			<MetaContext.Provider value={null}>
				<Layout>
					<PageSkeleton slow={meta.slow} />
				</Layout>
			</MetaContext.Provider>
		);
	}

	const mode = meta.data.meta.mode;

	return (
		<MetaContext.Provider value={meta.data}>
			<Layout>
				{mode === 'edge' ? (
					<Routes>
						<Route path="/overview" element={<EdgeOverview />} />
						<Route path="/workers" element={<EdgeWorkers />} />
						<Route path="/broadcasts" element={<EdgeBroadcasts />} />
						<Route path="/broadcasts/:roomId" element={<EdgeBroadcasts />} />
						<Route path="/pipe" element={<EdgePipe />} />
						<Route path="/viewers" element={<EdgeViewers />} />
						<Route path="/viewers/:viewerId" element={<EdgeViewerDetail />} />
						<Route path="/alerts" element={<EdgeAlerts />} />
						<Route path="*" element={<Navigate to="/overview" replace />} />
					</Routes>
				) : (
					<Routes>
						<Route path="/overview" element={<OriginOverview />} />
						<Route path="/rooms" element={<OriginRooms />} />
						<Route path="/rooms/:roomId" element={<OriginRooms />} />
						<Route path="/broadcasters/:broadcasterId" element={<OriginBroadcaster />} />
						<Route path="/edges" element={<OriginEdges />} />
						<Route path="/alerts" element={<EdgeAlerts />} />
						<Route path="*" element={<Navigate to="/overview" replace />} />
					</Routes>
				)}
			</Layout>
		</MetaContext.Provider>
	);
}
