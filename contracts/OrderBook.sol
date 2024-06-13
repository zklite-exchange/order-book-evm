// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/structs/BitMaps.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {ReentrancyGuard} from "./ReentrancyGuard.sol";
import {EIP712} from "./EIP712.sol";

contract OrderBook is EIP712, ReentrancyGuard {
    bytes32 private constant SUBMIT_ORDER_TYPE_HASH =
    keccak256("SubmitOrder(uint8 side,uint256 price,uint256 amount,uint16 pairId,uint32 validUntil,uint8 tif,uint256 networkFee,uint256 nonce,uint256[] orderIdsToCancel,uint256[] orderIdsToFill)");

    enum OrderSide {
        BUY, SELL
    }

    enum TimeInForce {
        GTC, IOK, FOK
    }

    error NotFilled();

    event NewPairConfigEvent (
        ERC20 indexed baseToken,
        ERC20 indexed quoteToken,
        uint minExecuteQuote,
        uint minQuoteChargeFee,
        uint16 indexed id,
        uint16 takerFeeBps,
        uint16 makerFeeBps,
        uint8 priceDecimals,
        bool active
    );

    event NewOrderEvent (
        uint indexed orderId,
        address indexed owner,
        uint price,
        uint amount,
        uint16 indexed pairId,
        OrderSide side,
        uint40 validUntil
    );

    event FillEvent (
        uint indexed makerOrderId,
        uint indexed takerOrderId,
        address maker,
        address taker,
        uint executedQuote,
        uint executedBase,
        uint feeTaker,
        uint feeMaker,
        uint16 indexed pairId,
        OrderSide takerSide
    );

    enum OrderCloseReason {
        FILLED, CANCELLED, EXPIRED, OUT_OF_BALANCE, OUT_OF_ALLOWANCE, EXPIRED_IOK
    }

    event OrderClosedEvent (
        uint indexed orderId,
        address indexed owner,
        uint receivedAmt,
        uint executedAmt,
        uint feeAmt,
        uint16 indexed pairId,
        OrderSide side,
        OrderCloseReason reason
    );

    struct Order {
        uint id;
        address owner;
        uint price;
        uint amount;
        uint unfilledAmt;
        uint receivedAmt; // receivedAmt included fee, actual amount received = receivedAmt - feeAmt
        uint feeAmt;
        uint16 pairId;
        OrderSide side;
        uint40 validUntil;
    }

    struct Pair {
        ERC20 baseToken; // immutable
        ERC20 quoteToken; // immutable
        uint minExecuteQuote;
        uint minQuoteChargeFee;
        uint16 id; // immutable
        uint16 takerFeeBps;
        uint16 makerFeeBps;
        uint8 priceDecimals; // immutable
        bool active;
    }

    uint internal orderCount = 0;
    uint internal pairCounts = 0;

    mapping(uint => Order) internal activeOrders;
    EnumerableSet.UintSet internal activeOrderIds;
    mapping(uint => Pair) internal pairs;
    EnumerableSet.UintSet internal activePairIds;
    mapping(address => EnumerableSet.UintSet) internal userActiveOrderIds;
    mapping(address => mapping(ERC20 => uint)) internal userSpendingAmount;
    mapping(address => BitMaps.BitMap) internal userNonce;

    address internal admin;

    constructor(address _admin) EIP712("zkLite Order Book", "v1") {
        require(_admin != address(0), "Invalid admin address");
        admin = _admin;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) {
            revert("Unauthorized access");
        }
        _;
    }

    function setAdmin(address newAdmin) public onlyAdmin {
        require(newAdmin != address(0), "Invalid admin address");
        admin = newAdmin;
    }

    function getAdmin() public view returns (address) {
        return admin;
    }

    function createPair(
        ERC20 baseToken,
        ERC20 quoteToken,
        uint8 priceDecimals,
        uint minExecuteQuote,
        uint minQuoteChargeFee,
        uint16 takerFeeBps,
        uint16 makerFeeBps
    ) public onlyAdmin returns (uint16 pairId) {
        require(takerFeeBps < 1000); // < 10%, avoid accidentally set high fee
        require(makerFeeBps < 1000); // < 10%, avoid accidentally set high fee
        require(
            priceDecimals < 200
            && priceDecimals >= baseToken.decimals()
            && priceDecimals >= quoteToken.decimals()
        );

        pairId = uint16(++pairCounts);
        pairs[pairId] = Pair(
            baseToken, quoteToken, minExecuteQuote, minQuoteChargeFee,
            pairId, takerFeeBps, makerFeeBps, priceDecimals, true
        );
        EnumerableSet.add(activePairIds, pairId);

        emit NewPairConfigEvent(
            baseToken, quoteToken, minExecuteQuote, minQuoteChargeFee,
            pairId, takerFeeBps, makerFeeBps, priceDecimals, true
        );
    }

    function setMinQuote(uint16 pairId, uint minExecuteQuote, uint minQuoteChargeFee) public onlyAdmin {
        Pair storage pair = pairs[pairId];
        require(pair.id > 0, "Invalid pairId");
        pair.minExecuteQuote = minExecuteQuote;
        pair.minQuoteChargeFee = minQuoteChargeFee;

        emit NewPairConfigEvent(
            pair.baseToken, pair.quoteToken, minExecuteQuote, minQuoteChargeFee,
            pairId, pair.takerFeeBps, pair.makerFeeBps, pair.priceDecimals, pair.active
        );
    }

    function setFee(uint16 pairId, uint8 takerFeeBps, uint8 makerFeeBps) public onlyAdmin {
        require(takerFeeBps < 1000); // < 10%, avoid accidentally set high fee
        require(makerFeeBps < 1000); // < 10%, avoid accidentally set high fee

        Pair storage pair = pairs[pairId];
        require(pair.id > 0, "Invalid pairId");

        pair.takerFeeBps = takerFeeBps;
        pair.makerFeeBps = makerFeeBps;

        emit NewPairConfigEvent(
            pair.baseToken, pair.quoteToken, pair.minExecuteQuote, pair.minQuoteChargeFee,
            pairId, takerFeeBps, makerFeeBps, pair.priceDecimals, pair.active
        );
    }

    function setPairActive(uint16 pairId, bool active) public onlyAdmin {
        Pair storage pair = pairs[pairId];
        require(pair.id > 0, "Invalid pairId");
        if (active != pair.active) {
            pair.active = active;

            if (active) {
                assert(EnumerableSet.add(activePairIds, pairId));
            } else {
                assert(EnumerableSet.remove(activePairIds, pairId));
            }

            emit NewPairConfigEvent(
                pair.baseToken, pair.quoteToken, pair.minExecuteQuote, pair.minQuoteChargeFee,
                pairId, pair.takerFeeBps, pair.makerFeeBps, pair.priceDecimals, active
            );
        }
    }

    function isUserNonceUsed(address user, uint value) public view returns (bool) {
        return BitMaps.get(userNonce[user], value);
    }

    function submitOrderOnBehalfOf(
        address user,
        OrderSide side,
        uint price,
        uint amount,
        uint16 pairId,
        uint32 validUntil,
        TimeInForce tif,
        uint networkFee,
        uint nonce,
        uint[] calldata orderIdsToCancel,
        uint[] calldata orderIdsToFill,
        uint8 v, bytes32 r, bytes32 s
    ) public nonReentrant returns (uint) {
        require(!isUserNonceUsed(user, nonce), "Nonce is used");
        BitMaps.set(userNonce[user], nonce);

        bytes32 structHash = keccak256(
            abi.encode(
                SUBMIT_ORDER_TYPE_HASH,
                uint8(side), price, amount, pairId,
                validUntil, uint8(tif), networkFee, nonce,
                keccak256(abi.encodePacked(orderIdsToCancel)),
                keccak256(abi.encodePacked(orderIdsToFill))
            )
        );
        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(hash, v, r, s);

        if (signer != user) {
            revert("Invalid signature");
        }

        return __submitOrder(user, side, price, amount, pairId, validUntil, tif, networkFee, orderIdsToCancel, orderIdsToFill);
    }

    function submitOrder(
        OrderSide side,
        uint price,
        uint amount,
        uint16 pairId,
        uint32 validUntil,
        TimeInForce tif,
        uint[] calldata orderIdsToCancel,
        uint[] calldata orderIdsToFill
    ) public nonReentrant returns (uint) {
        return __submitOrder(msg.sender, side, price, amount, pairId, validUntil, tif, 0, orderIdsToCancel, orderIdsToFill);
    }

    function __submitOrder(
        address owner,
        OrderSide side,
        uint price,
        uint amount,
        uint16 pairId,
        uint32 validUntil,
        TimeInForce tif,
        uint networkFee,
        uint[] calldata orderIdsToCancel,
        uint[] calldata orderIdsToFill
    ) private returns (uint orderId) {
        require(validUntil > block.timestamp, "Invalid validUntil");
        require(price > 0, "Invalid price");
        require(amount > 0, "Invalid amount");

        Pair memory pair = pairs[pairId];
        require(pair.id > 0, "Invalid pairId");
        require(pair.active, "Pair isn't active");

        if (side == OrderSide.BUY) {
            require(amount >= pair.minExecuteQuote, "Amount too small");
        } else {
            require(Math.mulDiv(amount, price, 10 ** pair.priceDecimals) >= pair.minExecuteQuote, "Amount too small");
        }

        // cancel old orders if specify
        if (orderIdsToCancel.length > 0) {
            cancelOrderInternal(owner, orderIdsToCancel);
        }

        ERC20 spendingToken = side == OrderSide.BUY ? pair.quoteToken : pair.baseToken;
        if (networkFee > 0) {
            spendingToken.transferFrom(owner, admin, networkFee);
        }

        uint spendingAmount = userSpendingAmount[owner][spendingToken] + amount;
        require(spendingToken.balanceOf(owner) >= spendingAmount, "Not enough balance");
        require(spendingToken.allowance(owner, address(this)) >= spendingAmount, "Exceed allowance");

        orderId = ++orderCount;

        Order memory order = Order(orderId, owner, price, amount, amount, 0, 0, pairId, side, validUntil);
        emit NewOrderEvent(
            orderId, owner,
            price, amount,
            pairId, side, validUntil
        );

        if (orderIdsToFill.length > 0) {
            for (uint i = 0; i < orderIdsToFill.length;) {
                tryFillOrder(pair, order, activeOrders[orderIdsToFill[i]]);
                if (order.unfilledAmt == 0) {
                    emit OrderClosedEvent(
                        orderId, owner, order.receivedAmt, amount, order.feeAmt,
                        pairId, side, OrderCloseReason.FILLED
                    );

                    return orderId;
                }

                unchecked {i++;}
            }
        }

        if (tif == TimeInForce.GTC) {
            activeOrders[orderId] = order;
            EnumerableSet.add(activeOrderIds, orderId);
            EnumerableSet.add(userActiveOrderIds[owner], orderId);
            userSpendingAmount[owner][spendingToken] += order.unfilledAmt;
        } else if (tif == TimeInForce.IOK) {
            emit OrderClosedEvent(
                orderId, owner, order.receivedAmt, amount - order.unfilledAmt, order.feeAmt,
                pairId, side, OrderCloseReason.EXPIRED_IOK
            );
        } else {
            revert NotFilled();
        }
    }

    function tryFillOrder(Pair memory pair, Order memory takerOrder, Order storage makerOrder) private returns (bool) {
        if (makerOrder.id == 0) return false; // order no longer active, skip
        if (makerOrder.validUntil < block.timestamp) {
            closeOrderUnsafe(makerOrder, OrderCloseReason.EXPIRED);
            return false;
        }
        if (makerOrder.pairId != takerOrder.pairId) return false; // invalid pair, skip
        if (makerOrder.side == takerOrder.side) return false; // invalid side, skip
        if (makerOrder.owner == takerOrder.owner) return false; // can't fill self order, skip

        //**! in case partial fill, unfilled amount must have notional value in quote >= minExecuteQuote

        uint priceDecimalPow = 10 ** pair.priceDecimals;
        if (takerOrder.side == OrderSide.BUY) {
            // if sell price > buy price, skip
            if (makerOrder.price > takerOrder.price) return false;

            uint makerUnfilledBase = makerOrder.unfilledAmt;
            if (pair.baseToken.balanceOf(makerOrder.owner) < makerUnfilledBase) {
                closeOrderUnsafe(makerOrder, OrderCloseReason.OUT_OF_BALANCE);
                return false;
            }
            if (pair.baseToken.allowance(makerOrder.owner, address(this)) < makerUnfilledBase) {
                closeOrderUnsafe(makerOrder, OrderCloseReason.OUT_OF_ALLOWANCE);
                return false;
            }


            uint takerUnfilledQuote = takerOrder.unfilledAmt;
            (uint executeQuote, uint executeBase) = calcExecuteAmount(
                takerUnfilledQuote, makerUnfilledBase, pair.minExecuteQuote,
                makerOrder.price, priceDecimalPow
            );

            if (executeQuote == 0) {
                assert(executeBase == 0);
                return false;
            }
            uint quoteFee;
            uint baseFee;
            if (executeQuote >= pair.minQuoteChargeFee) {
                if (pair.makerFeeBps > 0) {
                    quoteFee = Math.mulDiv(executeQuote, pair.makerFeeBps, 10000);
                }
                if (pair.takerFeeBps > 0) {
                    baseFee = Math.mulDiv(executeBase, pair.takerFeeBps, 10000);
                }
            }

            pair.baseToken.transferFrom(makerOrder.owner, takerOrder.owner, executeBase - baseFee);
            if (baseFee > 0) {
                pair.baseToken.transferFrom(makerOrder.owner, admin, baseFee);
            }

            pair.quoteToken.transferFrom(takerOrder.owner, makerOrder.owner, executeQuote - quoteFee);
            if (quoteFee > 0) {
                pair.quoteToken.transferFrom(takerOrder.owner, admin, quoteFee);
            }

            emit FillEvent(
                makerOrder.id,
                takerOrder.id,
                makerOrder.owner,
                takerOrder.owner,
                executeQuote,
                executeBase,
                baseFee,
                quoteFee,
                takerOrder.pairId,
                OrderSide.BUY
            );

            unchecked {
                makerOrder.unfilledAmt -= executeBase;
                makerOrder.receivedAmt += executeQuote;
                makerOrder.feeAmt += quoteFee;
            }
            userSpendingAmount[makerOrder.owner][pair.baseToken] -= executeBase;
            if (makerUnfilledBase == executeBase) {
                // filled 100%
                closeOrderUnsafe(makerOrder, OrderCloseReason.FILLED);
            }

            unchecked {
                takerOrder.unfilledAmt -= executeQuote;
                takerOrder.receivedAmt += executeBase;
                takerOrder.feeAmt += baseFee;
            }

            return true;
        } else {
            // if buy price < sell price, skip
            if (makerOrder.price < takerOrder.price) return false;

            uint makerUnfilledQuote = makerOrder.unfilledAmt;
            if (pair.quoteToken.balanceOf(makerOrder.owner) < makerUnfilledQuote) {
                closeOrderUnsafe(makerOrder, OrderCloseReason.OUT_OF_BALANCE);
                return false;
            }
            if (pair.quoteToken.allowance(makerOrder.owner, address(this)) < makerUnfilledQuote) {
                closeOrderUnsafe(makerOrder, OrderCloseReason.OUT_OF_ALLOWANCE);
                return false;
            }

            uint takerUnfilledBase = takerOrder.unfilledAmt;

            (uint executeQuote, uint executeBase) = calcExecuteAmount(
                makerUnfilledQuote, takerUnfilledBase, pair.minExecuteQuote,
                makerOrder.price, priceDecimalPow
            );

            if (executeQuote == 0) {
                assert(executeBase == 0);
                return false;
            }

            uint quoteFee;
            uint baseFee;
            if (executeQuote >= pair.minQuoteChargeFee) {
                if (pair.takerFeeBps > 0) {
                    quoteFee = Math.mulDiv(executeQuote, pair.takerFeeBps, 10000);
                }
                if (pair.makerFeeBps > 0) {
                    baseFee = Math.mulDiv(executeBase, pair.makerFeeBps, 10000);
                }
            }

            pair.quoteToken.transferFrom(makerOrder.owner, takerOrder.owner, executeQuote - quoteFee);
            if (quoteFee > 0) {
                pair.quoteToken.transferFrom(makerOrder.owner, admin, quoteFee);
            }

            pair.baseToken.transferFrom(takerOrder.owner, makerOrder.owner, executeBase - baseFee);
            if (baseFee > 0) {
                pair.baseToken.transferFrom(takerOrder.owner, admin, baseFee);
            }

            emit FillEvent(
                makerOrder.id,
                takerOrder.id,
                makerOrder.owner,
                takerOrder.owner,
                executeQuote,
                executeBase,
                quoteFee,
                baseFee,
                takerOrder.pairId,
                OrderSide.SELL
            );

            unchecked {
                makerOrder.unfilledAmt -= executeQuote;
                makerOrder.receivedAmt += executeBase;
                makerOrder.feeAmt += baseFee;
            }
            userSpendingAmount[makerOrder.owner][pair.quoteToken] -= executeQuote;
            if (executeQuote == makerUnfilledQuote) {
                // filled 100%
                closeOrderUnsafe(makerOrder, OrderCloseReason.FILLED);
            }

            unchecked {
                takerOrder.unfilledAmt -= executeBase;
                takerOrder.receivedAmt += executeQuote;
                takerOrder.feeAmt += quoteFee;
            }

            return takerOrder.unfilledAmt == 0;
        }
    }

    /**
    @dev In case of partial fill, the remaining amount must have notional value in quote > minExecuteQuote.
    This logic helps avoiding ghost orders in order book (order with a very low amount that no one care).
    */
    function calcExecuteAmount(
        uint unfilledQuote,
        uint unfilledBase,
        uint minExecuteQuote,
        uint price,
        uint priceDecimalPow
    ) private pure returns (uint, uint) {
        uint executeQuote = Math.mulDiv(unfilledBase, price, priceDecimalPow);
        uint executeBase;
        if (executeQuote == unfilledQuote) {
            executeBase = unfilledBase;
        } else if (executeQuote > unfilledQuote) {
            unchecked {
                if (executeQuote - unfilledQuote >= minExecuteQuote) {
                    executeQuote = unfilledQuote;
                } else if (unfilledQuote >= minExecuteQuote * 2) {
                    executeQuote = unfilledQuote - minExecuteQuote;
                } else {
                    // couldn't fill, because remaining amount will be < minExecuteQuote
                    return (0, 0);
                }
            }
            executeBase = Math.mulDiv(executeQuote, priceDecimalPow, price);
        } else {
            unchecked {
                if (unfilledQuote - executeQuote >= minExecuteQuote) {
                    executeBase = unfilledBase;
                } else if (executeQuote >= minExecuteQuote * 2) {
                    executeQuote = executeQuote - minExecuteQuote;
                    executeBase = Math.mulDiv(executeQuote, priceDecimalPow, price);
                } else {
                    return (0, 0);
                }
            }
        }

        assert(executeBase > 0 && executeBase <= unfilledBase);
        return (executeQuote, executeBase);
    }

    function getActivePairIds() public view returns (uint[] memory) {
        return EnumerableSet.values(activePairIds);
    }

    function getPair(uint16 pairId) public view returns (Pair memory) {
        return pairs[pairId];
    }

    function getActiveOrderIds() public view returns (uint[] memory) {
        return EnumerableSet.values(activeOrderIds);
    }

    function getActiveOrderIdsOf(address who) public view returns (uint[] memory) {
        return EnumerableSet.values(userActiveOrderIds[who]);
    }

    function getOrder(uint orderId) public view returns (Order memory) {
        return activeOrders[orderId];
    }

    function getSpendingAmount(address user, ERC20 token) public view returns (uint) {
        return userSpendingAmount[user][token];
    }

    function cancelOrder(uint[] calldata orderIds) public nonReentrant {
        cancelOrderInternal(msg.sender, orderIds);
    }

    // reentrancy safe
    function cancelOrderInternal(address caller, uint[] calldata orderIds) private {
        for (uint i = 0; i < orderIds.length;) {
            Order storage order = activeOrders[orderIds[i]];
            if (order.id > 0) {
                require(order.owner == caller, "Unauthorized");
                closeOrderUnsafe(order, OrderCloseReason.CANCELLED);
            }
            unchecked {i++;}
        }
    }

    function closeOrderUnsafe(Order storage order, OrderCloseReason reason) private {
        uint orderId = order.id;
        address owner = order.owner;

        EnumerableSet.UintSet storage _userActiveOrderIds = userActiveOrderIds[owner];
        assert(EnumerableSet.remove(activeOrderIds, orderId));
        assert(EnumerableSet.remove(_userActiveOrderIds, orderId));

        if (reason != OrderCloseReason.FILLED) {
            Pair memory pair = pairs[order.pairId];
            if (order.side == OrderSide.BUY) {
                userSpendingAmount[owner][pair.quoteToken] -= order.unfilledAmt;
            } else {
                userSpendingAmount[owner][pair.baseToken] -= order.unfilledAmt;
            }
        }

        emit OrderClosedEvent(
            orderId, owner, order.receivedAmt, order.amount - order.unfilledAmt, order.feeAmt,
            order.pairId, order.side, reason
        );

        delete activeOrders[orderId];
    }
}
