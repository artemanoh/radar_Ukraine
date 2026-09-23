#pragma once

#include <string>
#include <vector>

/**
 * @brief Geographic coordinates.
 */
struct GeoPoint {
    double lat; /**< Latitude in degrees */
    double lon; /**< Longitude in degrees */
};

/**
 * @brief Velocity components.
 */
struct Velocity {
    double vx_ms; /**< Velocity eastward in meters per second */
    double vy_ms; /**< Velocity northward in meters per second */
};

/**
 * @brief Target definition.
 */
struct Target {
    std::string id;       /**< Unique target identifier */
    GeoPoint position;    /**< Current geographic position */
    Velocity velocity;    /**< Current velocity */
    double altitude_m;    /**< Altitude in meters */
    double timestamp_s;   /**< Observation timestamp in seconds */
};

/**
 * @brief Threat zone representation (Cone of Uncertainty).
 */
struct ThreatZone {
    std::string target_id;              /**< Target identifier */
    std::vector<GeoPoint> cone_polygon; /**< Closed polygon of the threat zone */
    double eta_seconds;                 /**< Estimated time of arrival to impact */
    double certainty_probability;       /**< Probability of the target staying in the zone [0.0, 1.0] */
};

/**
 * @brief Engine for target trajectory calculation and prediction.
 */
class TrajectoryEngine {
public:
    /**
     * @brief Computes the ThreatZone (Cone of Uncertainty) for a target.
     * @param target The target object.
     * @param forecast_seconds How far into the future to forecast (seconds).
     * @param cone_steps Number of steps to discretize the cone.
     * @return Computed ThreatZone polygon and metadata.
     */
    ThreatZone computeThreatZone(const Target& target, double forecast_seconds, int cone_steps) const;

    /**
     * @brief Projects a position forward in time given velocity and duration.
     * @param origin Starting coordinate.
     * @param vx Velocity eastward (m/s).
     * @param vy Velocity northward (m/s).
     * @param dt_seconds Duration of travel (seconds).
     * @return New geographic coordinate.
     */
    GeoPoint projectPosition(const GeoPoint& origin, double vx, double vy, double dt_seconds) const;

    /**
     * @brief Calculates the Haversine distance between two points.
     * @param a First point.
     * @param b Second point.
     * @return Distance in meters.
     */
    double haversineDistance(const GeoPoint& a, const GeoPoint& b) const;

    /**
     * @brief Computes the estimated time of arrival from current to destination.
     * @param current Current position.
     * @param destination Destination position.
     * @param velocity Current velocity of the object.
     * @return Estimated time of arrival in seconds, or -1.0 if not moving towards destination.
     */
    double computeETA(const GeoPoint& current, const GeoPoint& destination, const Velocity& velocity) const;
};
