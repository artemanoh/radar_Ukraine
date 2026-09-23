#include "trajectory.hpp"
#include <cmath>
#include <algorithm>

constexpr double PI = 3.14159265358979323846;
constexpr double DEG_TO_RAD = PI / 180.0;
constexpr double RAD_TO_DEG = 180.0 / PI;
constexpr double EARTH_RADIUS_M = 6371000.0;

double TrajectoryEngine::haversineDistance(const GeoPoint& a, const GeoPoint& b) const {
    double lat1 = a.lat * DEG_TO_RAD;
    double lat2 = b.lat * DEG_TO_RAD;
    double dlat = lat2 - lat1;
    double dlon = (b.lon - a.lon) * DEG_TO_RAD;

    double s_dlat = std::sin(dlat / 2.0);
    double s_dlon = std::sin(dlon / 2.0);

    double a_val = s_dlat * s_dlat + std::cos(lat1) * std::cos(lat2) * s_dlon * s_dlon;
    double c = 2.0 * std::atan2(std::sqrt(a_val), std::sqrt(1.0 - a_val));

    return EARTH_RADIUS_M * c;
}

GeoPoint TrajectoryEngine::projectPosition(const GeoPoint& origin, double vx, double vy, double dt_seconds) const {
    GeoPoint result;
    // 1 degree of latitude is roughly 111319.9 meters
    result.lat = origin.lat + (vy * dt_seconds) / 111319.9;
    
    // 1 degree of longitude varies with latitude
    double cos_lat = std::cos(origin.lat * DEG_TO_RAD);
    if (std::abs(cos_lat) < 1e-6) { cos_lat = 1e-6; } // Avoid division by zero at poles
    result.lon = origin.lon + (vx * dt_seconds) / (111319.9 * cos_lat);
    return result;
}

ThreatZone TrajectoryEngine::computeThreatZone(const Target& target, double forecast_seconds, int cone_steps) const {
    constexpr double BASE_RADIUS_M = 500.0;
    constexpr double UNCERTAINTY_RATE = 15.0; // m/s

    ThreatZone tz;
    tz.target_id = target.id;
    tz.certainty_probability = 0.95; 
    tz.eta_seconds = forecast_seconds; // Simplified ETA

    if (cone_steps <= 0) return tz;

    std::vector<GeoPoint> left_side;
    std::vector<GeoPoint> right_side;

    double dt = forecast_seconds / cone_steps;
    double heading = std::atan2(target.velocity.vx_ms, target.velocity.vy_ms); // radians

    // Calculate normal directions for lateral offsets
    double left_vx = std::sin(heading - PI / 2.0);
    double left_vy = std::cos(heading - PI / 2.0);
    
    double right_vx = std::sin(heading + PI / 2.0);
    double right_vy = std::cos(heading + PI / 2.0);

    for (int i = 0; i <= cone_steps; ++i) {
        double t_i = i * dt;
        double radius = BASE_RADIUS_M + UNCERTAINTY_RATE * t_i;

        GeoPoint center = projectPosition(target.position, target.velocity.vx_ms, target.velocity.vy_ms, t_i);
        
        // Perpendicular offset based on radius (treating radius as movement dt in normal direction for projection)
        GeoPoint left_pt = projectPosition(center, left_vx * radius, left_vy * radius, 1.0);
        GeoPoint right_pt = projectPosition(center, right_vx * radius, right_vy * radius, 1.0);

        left_side.push_back(left_pt);
        right_side.push_back(right_pt);
    }

    tz.cone_polygon.reserve(left_side.size() + right_side.size() + 1);
    
    // Build polygon (left side forward, right side backward)
    for (const auto& pt : left_side) {
        tz.cone_polygon.push_back(pt);
    }
    for (auto it = right_side.rbegin(); it != right_side.rend(); ++it) {
        tz.cone_polygon.push_back(*it);
    }
    
    // Close polygon
    if (!tz.cone_polygon.empty()) {
        tz.cone_polygon.push_back(tz.cone_polygon.front());
    }

    return tz;
}

double TrajectoryEngine::computeETA(const GeoPoint& current, const GeoPoint& destination, const Velocity& velocity) const {
    double speed = std::sqrt(velocity.vx_ms * velocity.vx_ms + velocity.vy_ms * velocity.vy_ms);
    if (speed < 0.1) return -1.0;

    // Approximated flat bearing
    double bearing_to_dest = std::atan2(destination.lon - current.lon, destination.lat - current.lat); // simple map projection
    double heading = std::atan2(velocity.vx_ms, velocity.vy_ms);

    double angle_diff = heading - bearing_to_dest;
    double effective_speed = speed * std::cos(angle_diff);

    if (effective_speed <= 0) return -1.0;

    double distance = haversineDistance(current, destination);
    return distance / effective_speed;
}
