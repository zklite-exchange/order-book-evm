// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

// BEGIN-DEBUG
import "hardhat/console.sol";
// END-DEBUG

contract OrderBook is Ownable, ReentrancyGuard {

    enum OrderSide {
        BUY, SELL
    }

    event NewOrderEvent (
        uint indexed orderId,
        address indexed owner,
        uint price,
        uint amount,
        OrderSide side,
        uint40 validUntil
    );

    event FillEvent (
        uint indexed makerOrderId,
        uint indexed takerOrderId,
        address indexed maker,
        address taker,
        uint executedQuote,
        uint executedBase,
        uint feeTaker,
        uint feeMaker,
        OrderSide takerSide
    );

    enum OrderCloseReason {
        FILLED, CANCELLED, EXPIRED, OUT_OF_BALANCE, OUT_OF_ALLOWANCE
    }

    event OrderClosedEvent (
        uint indexed orderId,
        address indexed owner,
        uint receivedAmt,
        uint executedAmt,
        uint feeAmt,
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
        OrderSide side;
        uint40 validUntil;
    }

    struct User {
        EnumerableSet.UintSet activeOrderIds;
        uint spendingBase;
        uint spendingQuote;
    }

    ERC20 public immutable baseToken;
    ERC20 public immutable quoteToken;
    uint8 public immutable priceDecimals;
    uint private immutable priceDecimalPow;

    uint public minQuote;
    uint16 public takerFeeBps;
    uint16 public makerFeeBps;

    uint public orderCount = 0;
    mapping(uint => Order) internal activeOrders;
    mapping(address => User) internal users;
    EnumerableSet.UintSet internal activeOrderIds;


    constructor(
        address owner,
        ERC20 _baseToken,
        ERC20 _quoteToken,
        uint8 _priceDecimals,
        uint _minQuote,
        uint16 _takerFeeBps,
        uint16 _makerFeeBps
    ) Ownable(owner) {
        require(_takerFeeBps < 1000); // < 10%, avoid accidentally set high fee
        require(_makerFeeBps < 1000); // < 10%, avoid accidentally set high fee
        require(
            _priceDecimals < 200
            && _priceDecimals >= _baseToken.decimals()
            && _priceDecimals >= _quoteToken.decimals()
        );
        baseToken = _baseToken;
        quoteToken = _quoteToken;
        priceDecimals = _priceDecimals;
        priceDecimalPow = 10 ** _priceDecimals;

        minQuote = _minQuote;
        takerFeeBps = _takerFeeBps;
        makerFeeBps = _makerFeeBps;
    }

    function setMinQuote(uint _minQuote) public onlyOwner {
        minQuote = _minQuote;
    }

    function setFee(uint8 _takerFeeBps, uint8 _makerFeeBps) public onlyOwner {
        require(_takerFeeBps < 1000); // < 10%, avoid accidentally set high fee
        require(_makerFeeBps < 1000); // < 10%, avoid accidentally set high fee
        takerFeeBps = _takerFeeBps;
        makerFeeBps = _makerFeeBps;
    }

    function submitOrder(
        OrderSide side,
        uint price,
        uint amount,
        uint32 validUntil,
        uint[] calldata orderIdsToFill
    ) public nonReentrant returns (uint orderId) {
        require(validUntil > block.timestamp, "Invalid validUntil");
        require(amount > 0, "Invalid amount");
        require(price > 0, "Invalid price");

        User storage user = users[msg.sender];
        if (side == OrderSide.BUY) {
            if (quoteToken.balanceOf(msg.sender) < user.spendingQuote + amount) {
                revert("Not enough balance");
            }
            if (quoteToken.allowance(msg.sender, address(this)) < user.spendingQuote + amount) {
                revert("Exceed quote allowance");
            }
        } else {
            if (baseToken.balanceOf(msg.sender) < user.spendingBase + amount) {
                revert("Not enough balance");
            }
            if (baseToken.allowance(msg.sender, address(this)) < user.spendingBase + amount) {
                revert("Exceed base allowance");
            }
        }

        orderId = ++orderCount;

        Order memory order = Order(orderId, msg.sender, price, amount, amount, 0, 0, side, validUntil);
        emit NewOrderEvent(
            orderId, msg.sender,
            price, amount,
            side, validUntil
        );

        if (orderIdsToFill.length > 0) {
            for (uint i = 0; i < orderIdsToFill.length;) {
                // BEGIN-DEBUG
                uint startGas = gasleft();
                // END-DEBUG

                if (tryFillOrder(order, activeOrders[orderIdsToFill[i]])) {
                    emit OrderClosedEvent(
                        orderId, msg.sender, order.receivedAmt, amount, order.feeAmt,
                        side, OrderCloseReason.FILLED
                    );
                    return orderId;
                }

                // BEGIN-DEBUG
                uint gasCost = startGas - gasleft();
                console.log("Fill order %d cost %d gas", orderIdsToFill[i], gasCost);
                // END-DEBUG

                unchecked {i++;}
            }
        }

        activeOrders[orderId] = order;
        EnumerableSet.add(activeOrderIds, orderId);
        EnumerableSet.add(user.activeOrderIds, orderId);
        if (side == OrderSide.BUY) {
            user.spendingQuote += order.unfilledAmt;
        } else {
            user.spendingBase += order.unfilledAmt;
        }
        return orderId;
    }

    /**
    @return true if taker order is filled 100%
    */
    function tryFillOrder(Order memory takerOrder, Order storage makerOrder) private returns (bool) {
        if (makerOrder.id == 0) return false; // order no longer active, skip
        if (makerOrder.validUntil < block.timestamp) {
            closeOrderUnsafe(makerOrder, OrderCloseReason.EXPIRED);
            return false;
        }
        if (makerOrder.side == takerOrder.side) return false; // invalid side, skip
        if (makerOrder.owner == takerOrder.owner) return false; // can't fill self order, skip

        //**! in case partial fill, unfilled amount must have notional value in quote >= minQuote

        if (takerOrder.side == OrderSide.BUY) {
            // if sell price > buy price, skip
            if (makerOrder.price > takerOrder.price) return false;

            uint makerUnfilledBase = makerOrder.unfilledAmt;
            if (baseToken.balanceOf(makerOrder.owner) < makerUnfilledBase) {
                closeOrderUnsafe(makerOrder, OrderCloseReason.OUT_OF_BALANCE);
                return false;
            }
            if (baseToken.allowance(makerOrder.owner, address(this)) < makerUnfilledBase) {
                closeOrderUnsafe(makerOrder, OrderCloseReason.OUT_OF_ALLOWANCE);
                return false;
            }

            uint makerUnfilledQuote = Math.mulDiv(makerUnfilledBase, makerOrder.price, priceDecimalPow);

            uint takerUnfilledQuote = takerOrder.unfilledAmt;

            uint executeQuote;
            uint executeBase;
            if (makerUnfilledQuote == takerUnfilledQuote) {
                executeQuote = makerUnfilledQuote;
                executeBase = makerUnfilledBase;
            } else {
                if (makerUnfilledQuote > takerUnfilledQuote) {
                    unchecked {
                        if (makerUnfilledQuote - takerUnfilledQuote >= minQuote) {
                            executeQuote = takerUnfilledQuote;
                        } else if (takerUnfilledQuote >= minQuote * 2) {
                            executeQuote = takerUnfilledQuote - minQuote;
                        } else {
                            // can't enforce the logic that unfilled amount of both maker and taker must >= minQuote
                            return false;
                        }
                    }
                    executeBase = Math.mulDiv(executeQuote, priceDecimalPow, makerOrder.price);
                } else {
                    unchecked {
                        if (takerUnfilledQuote - makerUnfilledQuote >= minQuote) {
                            executeQuote = makerUnfilledQuote;
                            executeBase = makerUnfilledBase;
                        } else if (makerUnfilledQuote >= minQuote * 2) {
                            executeQuote = makerUnfilledQuote - minQuote;
                            executeBase = Math.mulDiv(executeQuote, priceDecimalPow, makerOrder.price);
                        } else {
                            // can't enforce the logic that unfilled amount of both maker and taker must >= minQuote
                            return false;
                        }
                    }
                }
            }
            uint quoteFee = makerFeeBps > 0 ? Math.mulDiv(executeQuote, makerFeeBps, 10000) : 0;
            uint baseFee = takerFeeBps > 0 ? Math.mulDiv(executeBase, takerFeeBps, 10000) : 0;

            baseToken.transferFrom(makerOrder.owner, takerOrder.owner, executeBase - baseFee);
            if (baseFee > 0) {
                baseToken.transferFrom(makerOrder.owner, address(this), baseFee);
            }

            quoteToken.transferFrom(takerOrder.owner, makerOrder.owner, executeQuote - quoteFee);
            if (quoteFee > 0) {
                quoteToken.transferFrom(takerOrder.owner, address(this), quoteFee);
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
                OrderSide.BUY
            );


            unchecked {
                makerOrder.unfilledAmt -= executeBase;
                makerOrder.receivedAmt += executeQuote;
                makerOrder.feeAmt += quoteFee;
                users[makerOrder.owner].spendingBase -= executeBase;
                if (executeBase == makerUnfilledBase) {
                    closeOrderUnsafe(makerOrder, OrderCloseReason.FILLED);
                }
            }

            unchecked {
                takerOrder.unfilledAmt -= executeQuote;
                takerOrder.receivedAmt += executeBase;
                takerOrder.feeAmt += baseFee;
            }

            return takerOrder.unfilledAmt == 0;
        } else {
            // if buy price < sell price, skip
            if (makerOrder.price < takerOrder.price) return false;

            uint makerUnfilledQuote = makerOrder.unfilledAmt;
            if (quoteToken.balanceOf(makerOrder.owner) < makerUnfilledQuote) {
                closeOrderUnsafe(makerOrder, OrderCloseReason.OUT_OF_BALANCE);
                return false;
            }
            if (quoteToken.allowance(makerOrder.owner, address(this)) < makerUnfilledQuote) {
                closeOrderUnsafe(makerOrder, OrderCloseReason.OUT_OF_ALLOWANCE);
                return false;
            }

            uint takerUnfilledBase = takerOrder.unfilledAmt;
            uint takerUnfilledQuote = Math.mulDiv(takerUnfilledBase, makerOrder.price, priceDecimalPow);

            uint executeQuote;
            uint executeBase;
            if (makerUnfilledQuote == takerUnfilledQuote) {
                executeQuote = takerUnfilledQuote;
                executeBase = takerUnfilledBase;
            } else {
                if (makerUnfilledQuote > takerUnfilledQuote) {
                    unchecked {
                        if (makerUnfilledQuote - takerUnfilledQuote >= minQuote) {
                            executeQuote = takerUnfilledQuote;
                            executeBase = takerUnfilledBase;
                        } else if (takerUnfilledQuote >= minQuote * 2) {
                            executeQuote = takerUnfilledQuote - minQuote;
                            executeBase = Math.mulDiv(executeQuote, priceDecimalPow, makerOrder.price);
                        } else {
                            // can't enforce the logic that unfilled amount of both maker and taker must >= minQuote
                            return false;
                        }
                    }
                } else {
                    unchecked {
                        if (takerUnfilledQuote - makerUnfilledQuote >= minQuote) {
                            executeQuote = makerUnfilledQuote;
                        } else if (makerUnfilledQuote >= minQuote * 2) {
                            executeQuote = makerUnfilledQuote - minQuote;
                        } else {
                            // can't enforce the logic that unfilled amount of both maker and taker must >= minQuote
                            return false;
                        }
                    }
                    executeBase = Math.mulDiv(executeQuote, priceDecimalPow, makerOrder.price);
                }
            }
            uint quoteFee = takerFeeBps > 0 ? Math.mulDiv(executeQuote, takerFeeBps, 10000) : 0;
            uint baseFee = makerFeeBps > 0 ? Math.mulDiv(executeBase, makerFeeBps, 10000) : 0;

            quoteToken.transferFrom(makerOrder.owner, takerOrder.owner, executeQuote - quoteFee);
            if (quoteFee > 0) {
                quoteToken.transferFrom(makerOrder.owner, address(this), quoteFee);
            }

            baseToken.transferFrom(takerOrder.owner, makerOrder.owner, executeBase - baseFee);
            if (baseFee > 0) {
                baseToken.transferFrom(takerOrder.owner, address(this), baseFee);
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
                OrderSide.SELL
            );

            unchecked {
                makerOrder.unfilledAmt -= executeQuote;
                makerOrder.receivedAmt += executeBase;
                makerOrder.feeAmt += baseFee;
                users[makerOrder.owner].spendingQuote -= executeQuote;
                if (executeQuote == makerUnfilledQuote) {
                    closeOrderUnsafe(makerOrder, OrderCloseReason.FILLED);
                }
            }

            unchecked {
                takerOrder.unfilledAmt -= executeBase;
                takerOrder.receivedAmt += executeQuote;
                takerOrder.feeAmt += quoteFee;
            }

            return takerOrder.unfilledAmt == 0;
        }
    }

    function getActiveOrderIds() public view returns (uint[] memory) {
        return EnumerableSet.values(activeOrderIds);
    }

    function getActiveOrderIdsOf(address who) public view returns (uint[] memory) {
        return EnumerableSet.values(users[who].activeOrderIds);
    }

    function getOrder(uint orderId) public view returns (Order memory) {
        return activeOrders[orderId];
    }

    function cancelOrder(uint orderId) public nonReentrant {
        require(orderId > 0, "Invalid order ID");
        Order storage order = activeOrders[orderId];
        require(order.id > 0, "Order not found");
        require(order.owner == msg.sender, "Unauthorized");

        closeOrderUnsafe(order, OrderCloseReason.CANCELLED);
    }

    function closeOrderUnsafe(Order storage order, OrderCloseReason reason) private {
        User storage user = users[order.owner];
        assert(EnumerableSet.remove(activeOrderIds, order.id));
        assert(EnumerableSet.remove(user.activeOrderIds, order.id));

        if (reason != OrderCloseReason.FILLED) {
            if (order.side == OrderSide.BUY) {
                user.spendingQuote -= order.unfilledAmt;
            } else {
                user.spendingBase -= order.unfilledAmt;
            }
        }

        if (EnumerableSet.length(user.activeOrderIds) == 0) {
            assert(user.spendingQuote == 0 && user.spendingBase == 0);
        }

        emit OrderClosedEvent(
            order.id, order.owner,
            order.receivedAmt, order.amount - order.unfilledAmt, order.feeAmt,
            order.side, reason
        );

        // BEGIN-DEBUG
        console.log("Order closed id = %d", order.id);
        console.log("Order closed receiveAmt = %d", order.receivedAmt);
        console.log("Order closed unfilledAmt = %d", order.unfilledAmt);
        console.log("Order closed feeAmt = %d", order.feeAmt);
        // END-DEBUG

        delete activeOrders[order.id];
    }
}